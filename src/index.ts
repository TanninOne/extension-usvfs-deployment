import * as Promise from 'bluebird';
import { app as appIn, remote } from 'electron';
import I18next from 'i18next';
import * as path from 'path';
import * as usvfs from 'node-usvfs';
import turbowalk from 'turbowalk';
import { fs, types, util, selectors, log } from 'vortex-api';

const app = appIn !== undefined ? appIn : remote.app;

const METHOD_ID = 'usvfs-deployment';

const UNSUPPORTED_GAMES = [
  // starts indirectly via Origin, solutions welcome
  'thesims4',
  // starts fine but hangs when opening menu, probably usvfs interfers with opening a pipe, should be fixable
  'kingdomcomedeliverance',
];

/**
 * Games known to work:
 * Fallout: New Vegas
 * Neverwinter Nights: Enhanced Edition
 * Subnautica (only if started directly of course)
 * 
 * Games assumed to work:
 * Fallout 3
 * Fallout 4
 * Morrowind
 * Oblivion
 * Skyrim
 * Skyrim Special edition
 * Neverwinter Nights (original)
 */

class USVFSDeploymentMethod implements types.IDeploymentMethod {
  public id: string = METHOD_ID;
  public name: string = 'USVFS Deployment';
  public description: string = 'Deployment happens only in memory and affects only '
                             + 'applications started from Vortex';

  public isFallbackPurgeSafe: boolean = false;
  // priority: below hardlink deployment and symlink deployment without elevation
  //    but before elevated symlinking and move deployment
  public priority: number = 15;

  private mAPI: types.IExtensionApi;
  private mDataPath: string;
  private mDeployed: types.IDeployedFile[];

  constructor(api: types.IExtensionApi) {
    this.mAPI = api;
  }

  public detailedDescription(t: I18next.TFunction): string {
    return t(this.description);
  }

  public isSupported(state: any, gameId: string, modTypeId: string): any {
    if (process.platform !== 'win32') {
      return {
        description: t => t('Only supported on Windows'),
      };
    }
    if (UNSUPPORTED_GAMES.indexOf(gameId) !== -1) {
      return {
        description: t => t('Incompatible with "{{name}}".', {
          replace: {
            name: selectors.gameName(state, gameId),
          }
        }),
      };
    }
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

  public getDeployedPath(input: string): string {
    return input;
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

  public deactivate(installPath: string, dataPath: string): Promise<void> {
    return Promise.resolve();
  }

  public prePurge() {
    return Promise.resolve();
  }

  public postPurge() {
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


  public isDeployed(installPath: string, dataPath: string, file: types.IDeployedFile): Promise<boolean> {
    // O(n) meaning the calling function is probably going to be O(n^2)
    return Promise.resolve(this.mDeployed.find(deployed => deployed.relPath === file.relPath) !== undefined);
  }
}

function init(context: types.IExtensionContext) {
  context.registerDeploymentMethod(new USVFSDeploymentMethod(context.api));
  (context as any).registerStartHook(1000, 'usvfs-run', call => {
    const state = context.api.store.getState();
    const activator = selectors.currentActivator(state);
    if (activator !== METHOD_ID) {
      return Promise.resolve(call);
    }
    const stackErr = new Error();
    return new Promise((resolve, reject) => {
      if (util.getSafe(state, ['session', 'base', 'activity', 'mods'], []).indexOf('deployment') !== -1) {
        // don't try to trigger a deployment if this is run as part of deployment
        // (post-processing most likely)
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
      if ((logLevel === 'error') && (message.indexOf('never released the mutex') !== -1)) {
        // sometimes reported when closing a hooked application - doesn't seem to have any
        // negative effect
        return true;
      }
      log(logLevel, message.slice(tPos + 4));
      return true;
    }, (err) => {
      if (err !== null) {
        context.api.showErrorNotification('USVFS logging no longer monitored', err);
      }
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
