import * as Promise from 'bluebird';
import { app as appIn, remote } from 'electron';
import * as I18next from 'i18next';
import * as path from 'path';
import * as usvfs from 'node-usvfs';
import turbowalk from 'turbowalk';
import { fs, types, util, selectors, log } from 'vortex-api';

const app = appIn !== undefined ? appIn : remote.app;

const METHOD_ID = 'usvfs-deployment';

class USVFSDeploymentMethod implements types.IDeploymentMethod {
  public id: string = METHOD_ID;
  public name: string = 'USVFS Deployment';
  public description: string = 'Deployment happens only in memory and affects only '
                             + 'applications started from Vortex';

  public isFallbackPurgeSafe: boolean = false;

  private mAPI: types.IExtensionApi;
  private mDataPath: string;
  private mDeployed: types.IDeployedFile[];

  constructor(api: types.IExtensionApi) {
    this.mAPI = api;
  }

  public detailedDescription(t: I18next.TranslationFunction): string {
    return t(this.description);
  }

  public isSupported(state: any, gameId: string, modTypeId: string): string {
    return undefined;
  }

  public userGate(): Promise<void> {
    return Promise.resolve();
  }

  public prepare(dataPath: string,
                 clean: boolean,
                 lastActivation: types.IDeployedFile[]): Promise<void> {
    if (clean) {
      usvfs.ClearVirtualMappings();
    }
    this.mDataPath = dataPath;
    this.mDeployed = [];
    return Promise.resolve();
  }

  public finalize(gameId: string,
                  dataPath: string,
                  installationPath: string,
                  progressCB?: (files: number, total: number) => void):
      Promise<types.IDeployedFile[]> {
    return Promise.resolve(this.mDeployed);
  }

  public activate(sourcePath: string, sourceName: string, dataPath: string,
                  blackList: Set<string>): Promise<void> {
    return fs.statAsync(sourcePath)
      .then(() => {
        usvfs.VirtualLinkDirectoryStatic(sourcePath, path.join(this.mDataPath, dataPath), { recursive: true });
        return turbowalk(sourcePath, files => {
          this.mDeployed.push(...files.map(entry => ({
            relPath: path.relative(sourcePath, entry.filePath),
            source: sourceName,
            time: entry.mtime,
          })));
        });
      })
      .catch(() => null);
  }

  public deactivate(installPath: string, dataPath: string, mod: types.IMod): Promise<void> {
    return Promise.resolve();
  }

  public purge(installPath: string, dataPath: string): Promise<void> {
    usvfs.ClearVirtualMappings();
    return Promise.resolve();
  }

  public externalChanges(gameId: string, installPath: string, dataPath: string,
                         activation: types.IDeployedFile[]):
      Promise<types.IFileChange[]> {
    return Promise.resolve([]);
  }

  public isActive(): boolean {
    return false;
  }
}

function init(context: types.IExtensionContext) {
  let deploying = false;

  context.registerDeploymentMethod(new USVFSDeploymentMethod(context.api));
  (context as any).registerStartHook(1000, 'usvfs-run', call => {
    const state = context.api.store.getState();
    const activator = selectors.currentActivator(state);
    if (activator !== METHOD_ID) {
      return Promise.resolve(call);
    }
    const stackErr = new Error();
    return new Promise((resolve, reject) => {
      if (deploying) {
        // don't try to trigger a deployment if we're already in one
        return resolve();
      }

      const deployCB = (util as any).onceCB((err) => {
        if (err !== null) {
          return reject(err);
        } else {
          return resolve();
        }
      });
      deployCB.fromusvfs = true;
      context.api.events.emit('deploy-mods', deployCB);
    })
      .then(() => fs.statAsync(call.executable))
      .then(() => {
        try {
          usvfs.CreateProcessHooked(null, `${call.executable} ${call.args.join(' ')}`, call.options.cwd, {
            ...process.env,
            ...call.options.env
          });
        } catch (err) {
          err.stack = stackErr.stack;
          return Promise.reject(err);
        }
        return Promise.reject(new util.ProcessCanceled('run through usvfs'));
      })
      .catch({ code: 'ENOENT' }, () => {
        // if the executable doesn't exist it could be that it belongs to a mod and thus will exist after deployment.
        // In this case start through a cmd as a trampoline
        // TODO: This test could probably be more sophisticated
        try {
          const workingDir = call.options.cwd || path.dirname(call.executable);
          usvfs.CreateProcessHooked(null, `cmd /C "cd ${workingDir} && ${call.executable} ${call.args.join(' ')}"`, 'c:\\', {
            ...process.env,
            ...call.options.env
          });
        } catch (err) {
          err.stack = stackErr.stack;
          return Promise.reject(err);
        }
        return Promise.reject(new util.ProcessCanceled('run through usvfs'));
      });
  });

  context.once(() => {
    usvfs.CreateVFS({
      logLevel: 2,
      instanceName: 'vortex-usvfs',
      debugMode: false,
      crashDumpPath: path.join(app.getPath('temp'), 'usvfs_dumps'),
      crashDumpType: 1,
    });
    usvfs.InitLogging();
    (usvfs as any).PollLogMessages(message => {
      // log format:  11:00:08.860 <11004:16400> [D] ...
      const tPos = message.indexOf('[');
      const logLevel = {
        D: 'debug',
        I: 'info',
        W: 'warning',
        E: 'error',
      }[message[tPos + 1]] || 'warning';
      log(logLevel, message.slice(tPos + 4));
      return true;
    }, (err) => {
      if (err !== null) {
        context.api.showErrorNotification('USVFS logging no longer monitored', err);
      }
    });

    context.api.onAsync('will-deploy', () => {
      deploying = true;
      return Promise.resolve();
    });
    context.api.onAsync('did-deploy', () => {
      // ensure (?) the flag is only reset after other did-deploy handlers are completed
      setTimeout(() => {
        deploying = false;
      }, 100);
      return Promise.resolve();
    });

    context.api.events.prependListener('deploy-mods', (callback: (error) => void, profileId?: string) => {
      if ((callback as any).fromusvfs || deploying) {
        return;
      }
      const state: types.IState = context.api.store.getState();

      const profile: types.IProfile = profileId !== undefined
        ? util.getSafe(state, ['persistent', 'profiles', profileId], undefined)
        : selectors.activeProfile(state);
    });

    context.api.onStateChange(['settings', 'mods', 'activator'], (prev: { [gameId: string]: string }, next: { [gameId: string]: string }) => {
      const state = context.api.store.getState();
      const gameMode = selectors.activeGameId(state);
      // when the deployment method changes to or from usvfs we need to restart all helpers (like the loot process) so they will
      // start/stop using the virtual file system
      if ((prev[gameMode] !== next[gameMode])
          && ((prev[gameMode] === METHOD_ID)
          || (next[gameMode] === METHOD_ID))) {
        context.api.events.emit('restart-helpers');
      }
    });
  });

  return true;
}

export default init;
