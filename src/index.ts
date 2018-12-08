import * as Promise from 'bluebird';
import { app as appIn, remote } from 'electron';
import * as I18next from 'i18next';
import * as path from 'path';
import * as usvfs from 'usvfs';
import { types, util, selectors } from 'vortex-api';

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
    return Promise.resolve();
  }

  public finalize(gameId: string,
                  dataPath: string,
                  installationPath: string,
                  progressCB?: (files: number, total: number) => void):
      Promise<types.IDeployedFile[]> {
    return Promise.resolve([]);
  }

  public activate(sourcePath: string, sourceName: string, dataPath: string,
                  blackList: Set<string>): Promise<void> {
    usvfs.VirtualLinkDirectoryStatic(sourcePath, path.join(this.mDataPath, dataPath), { recursive: true });
    return Promise.resolve();
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
  context.registerDeploymentMethod(new USVFSDeploymentMethod(context.api));
  (context as any).registerStartHook(1000, 'usvfs-run', call => {
    return new Promise((resolve, reject) => {
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
      .then(() => {
        usvfs.CreateProcessHooked(null, `${call.executable} ${call.args.join(' ')}`, call.options.cwd, call.options.env);
        return Promise.reject(new util.ProcessCanceled('run through usvfs'));
      });
  });

  context.once(() => {
    usvfs.CreateVFS({
      logLevel: 1,
      instanceName: 'vortex-usvfs',
      debugMode: false,
      crashDumpPath: path.join(app.getPath('temp'), 'usvfs_dumps'),
      crashDumpType: 1,
    });

    context.api.events.prependListener('deploy-mods', (callback: (error) => void, profileId?: string) => {
      if ((callback as any).fromusvfs) {
        return;
      }
      const state: types.IState = context.api.store.getState();

      const profile: types.IProfile = profileId !== undefined
        ? util.getSafe(state, ['persistent', 'profiles', profileId], undefined)
        : selectors.activeProfile(state);

      const activator = (util as any).getCurrentActivator(state, profile.gameId, true);
      if (activator.id === METHOD_ID) {
        callback(new util.ProcessCanceled('Don\'t manually deploy when using usvfs deployment'));
        (callback as any).called = true;
      }
    });
  });

  return true;
}

export default init;
