import * as fs from 'fs';
import * as iam from '@aws-cdk/aws-iam';
import * as s3_assets from '@aws-cdk/aws-s3-assets';
import * as s3 from '@aws-cdk/aws-s3';
import { Construct, Duration } from '@aws-cdk/core';

/**
 * Defines whether this Init template will is being rendered for Windows or Linux-based systems.
 */
export enum InitRenderPlatform {
  /**
   * Render the config for a Windows platform
   */
  WINDOWS = 'WINDOWS',

  /**
   * Render the config for a Linux platform
   */
  LINUX = 'LINUX',
}

/**
 * The type of the init element.
 */
export enum InitElementType {
  /**
   * A package
   */
  PACKAGE = 'PACKAGE',

  /**
   * A group
   */
  GROUP = 'GROUP',

  /**
   * A user
   */
  USER = 'USER',

  /**
   * A source
   */
  SOURCE = 'SOURCE',

  /**
   * A file
   */
  FILE = 'FILE',

  /**
   * A command
   */
  COMMAND = 'COMMAND',

  /**
   * A service
   */
  SERVICE = 'SERVICE',
}

/**
 * Context options passed when an InitElement is being rendered
 */
export interface InitRenderOptions {
  /**
   * Which OS platform (Linux, Windows) are we rendering for. Impacts
   * which config types are available and how they are rendered.
   */
  readonly platform: InitRenderPlatform;

  /**
   * Ordered index of current element type. Primarily used to auto-generate
   * command keys and retain ordering.
   */
  readonly index: number;
}

/**
 * Context information passed when an InitElement is being consumed
 */
export interface InitBindOptions {
  /**
   * Instance role of the consuming instance or fleet
   */
  readonly instanceRole: iam.IRole;
}

/**
 * Base class for all CloudFormation Init elements
 */
export abstract class InitElement {

  /**
   * Returns the init element type for this element.
   */
  public abstract readonly elementType: InitElementType;

  /**
   * Render the CloudFormation representation of this init element.
   *
   * Should return an object with a single key: `{ key: { ...details... }}`
   *
   * @param options
   */
  public abstract renderElement(options: InitRenderOptions): Record<string, any>;

  /**
   * Called when the Init config is being consumed.
   */
  public bind(_scope: Construct, _options: InitBindOptions): void {
    // Default is no-op
  }
}

/**
 * Options for InitCommand
 */
export interface InitCommandOptions {
  /**
   * Identifier key for this command
   *
   * You can use this to order commands, or to reference this command in a service
   * definition to restart a service after this command runs.
   *
   * @default - Automatically generated
   */
  readonly key?: string;

  /**
   * Sets environment variables for the command.
   *
   * This property overwrites, rather than appends, the existing environment.
   *
   * @default - Use current environment
   */
  readonly env?: Record<string, string>;

  /**
   * The working directory
   *
   * @default - Use default working directory
   */
  readonly cwd?: string;

  /**
   * Command to determine whether this command should be run
   *
   * If the test passes (exits with error code or %ERRORLEVEL% of 0), the command is run.
   *
   * @default - Always run this command
   */
  readonly test?: string;

  /**
   * Continue running if this command fails
   *
   * @default false
   */
  readonly ignoreErrors?: boolean;

  /**
   * Specifies how long to wait (in seconds) after a command has finished in case the command causes a reboot.
   *
   * A value of "forever" directs cfn-init to exit and resume only after the
   * reboot is complete. Set this value to 0 if you do not want to wait for
   * every command.
   *
   * For Windows systems only.
   *
   * @default Duration.seconds(60)
   */
  readonly waitAfterCompletion?: Duration;
}

/**
 * Command to execute on the instance
 */
export class InitCommand extends InitElement {
  /**
   * Run a shell command
   *
   * You must escape the string appropriately.
   */
  public static shellCommand(shellCommand: string, options: InitCommandOptions = {}): InitCommand {
    return new InitCommand(shellCommand, options);
  }

  /**
   * Run a command from an argv array
   *
   * You do not need to escape space characters or enclose command parameters in quotes.
   */
  public static argvCommand(argv: string[], options: InitCommandOptions = {}): InitCommand {
    if (argv.length == 0) {
      throw new Error('Cannot define argvCommand with an empty arguments');
    }
    return new InitCommand(argv, options);
  }

  public readonly elementType = InitElementType.COMMAND;

  protected constructor(private readonly command: any, private readonly options: InitCommandOptions) {
    super();

    if (typeof this.command !== 'string' && !(Array.isArray(command) && command.every(s => typeof s === 'string'))) {
      throw new Error('\'command\' must be either a string or an array of strings');
    }
  }

  public renderElement(renderOptions: InitRenderOptions): Record<string, any> {
    const commandKey = this.options.key || (renderOptions.index + '').padStart(3, '0'); // 001, 005, etc.

    if (renderOptions.platform !== InitRenderPlatform.WINDOWS && this.options.waitAfterCompletion !== undefined) {
      throw new Error(`Command '${this.command}': 'waitAfterCompletion' is only valid for Windows systems.`);
    }

    return {
      [commandKey]: {
        command: this.command,
        env: this.options.env,
        cwd: this.options.cwd,
        test: this.options.test,
        ignoreErrors: this.options.ignoreErrors,
        waitAfterCompletion: this.options.waitAfterCompletion?.toSeconds(),
      },
    };
  }

}

/**
 * The content can be either inline in the template or the content can be
 * pulled from a URL.
 */
export interface InitFileOptions {
  /**
   * The name of the owning group for this file.
   *
   * Not supported for Windows systems.
   *
   * @default 'root'
   */
  readonly group?: string;

  /**
   * The name of the owning user for this file.
   *
   * Not supported for Windows systems.
   *
   * @default 'root'
   */
  readonly owner?: string;

  /**
   * A six-digit octal value representing the mode for this file.
   *
   * Use the first three digits for symlinks and the last three digits for
   * setting permissions. To create a symlink, specify 120xxx, where xxx
   * defines the permissions of the target file. To specify permissions for a
   * file, use the last three digits, such as 000644.
   *
   * Not supported for Windows systems.
   *
   * @default '000644'
   */
  readonly mode?: string;

  /**
   * True if the inlined content (from a string or file) should be treated as base64 encoded.
   * Only applicable for inlined string and file content.
   *
   * @default false
   */
  readonly base64Encoded?: boolean;
}

/**
 * Create files on the EC2 instance.
 */
export class InitFile extends InitElement {

  /**
   * Use a literal string as the file content
   */
  public static fromString(fileName: string, content: string, options: InitFileOptions = {}): InitFile {
    return new InitFile(fileName, content, options, true);
  }

  /**
   * Write a symlink with the given symlink target
   */
  public static symlink(fileName: string, target: string, options: InitFileOptions = {}): InitFile {
    const { mode, ...otherOptions } = options;
    if (mode && mode.slice(0, 3) !== '120') {
      throw new Error('File mode for symlinks must begin with 120XXX');
    }
    return new InitFile(fileName, target, { mode: (mode || '120644'), ...otherOptions }, true);
  }

  /**
   * Use a JSON-compatible object as the file content, write it to a JSON file.
   *
   * May contain tokens.
   */
  public static fromObject(fileName: string, obj: Record<string, any>, options: InitFileOptions = {}): InitFile {
    class InitFileObject extends InitFile {
      public renderElement(renderOptions: InitRenderOptions): Record<string, any> {
        return {
          [fileName]: {
            content: obj,
            ...this.renderOptions(options, renderOptions),
          },
        };
      }
    }
    return new InitFileObject(fileName, '', options);
  }

  /**
   * Read a file from disk and use its contents
   *
   * The file will be embedded in the template, so care should be taken to not
   * exceed the template size.
   *
   * If options.base64encoded is set to true, this will base64-encode the file's contents.
   */
  public static fromFileInline(targetFileName: string, sourceFileName: string, options: InitFileOptions = {}): InitFile {
    const encoding = options.base64Encoded ? 'base64' : 'utf8';
    const fileContents = fs.readFileSync(sourceFileName).toString(encoding);
    return new InitFile(targetFileName, fileContents, options, true);
  }

  /**
   * Create an asset from the given file and use that
   *
   * This is appropriate for files that are too large to embed into the template.
   */
  public static fromFileAsset(_targetFileName: string, _sourceFileName: string, _options: InitFileOptions = {}): InitFile {
    // TODO - No scope here, so can't create the Asset directly. Need to delay creation until bind() is called,
    // or find some other clever solution if we're going to support this.
    throw new Error('Not implemented.');
  }

  /**
   * Download from a URL at instance startup time
   */
  public static fromUrl(fileName: string, url: string, options: InitFileOptions = {}): InitFile {
    return new InitFile(fileName, url, options, false);
  }

  /**
   * Use a file from an asset at instance startup time
   */
  public static fromAsset(targetFileName: string, asset: s3_assets.Asset, options: InitFileOptions = {}): InitFile {
    class InitFileAsset extends InitFile {
      constructor() {
        super(targetFileName, asset.httpUrl, options, false);
      }

      public bind(_scope: Construct, _bindOptions: InitBindOptions) {
        // FIXME
        throw new Error('Not implemented.');
      }
    }
    return new InitFileAsset();
  }

  public readonly elementType = InitElementType.FILE;

  private readonly fileName: string;
  private readonly content: string;
  private readonly options: InitFileOptions;
  private readonly isInlineContent: boolean;

  protected constructor(fileName: string, content: string, options: InitFileOptions, isInlineContent: boolean = true) {
    super();

    this.fileName = fileName;
    this.content = content;
    this.options = options;
    this.isInlineContent = isInlineContent;
  }

  public renderElement(renderOptions: InitRenderOptions): Record<string, any> {
    return {
      [this.fileName]: {
        ...this.renderContentOrSource(),
        ...this.renderOptions(this.options, renderOptions),
      },
    };
  }

  private renderContentOrSource(): Record<string, any> {
    return this.isInlineContent ? {
      content: this.content,
      encoding: this.options.base64Encoded ? 'base64' : 'plain',
    } : {
      source: this.content,
    };
  }

  private renderOptions(fileOptions: InitFileOptions, renderOptions: InitRenderOptions): Record<string, any> {
    if (renderOptions.platform === InitRenderPlatform.WINDOWS) {
      if (fileOptions.group || fileOptions.owner || fileOptions.mode) {
        throw new Error('Owner, group, and mode options not supported for Windows.');
      }
      return {};
    }

    return {
      mode: fileOptions.mode || '000644',
      owner: fileOptions.owner || 'root',
      group: fileOptions.group || 'root',
    };
  }
}

/**
 * Create Linux/UNIX groups and to assign group IDs.
 *
 * Not supported for Windows systems.
 */
export class InitGroup extends InitElement {

  /**
   * Map a group name to a group id
   */
  public static fromName(groupName: string, groupId?: number): InitGroup {
    return new InitGroup(groupName, groupId);
  }

  public readonly elementType = InitElementType.GROUP;

  protected constructor(private groupName: string, private groupId?: number) {
    super();
  }

  public renderElement(options: InitRenderOptions): Record<string, any> {
    if (options.platform === InitRenderPlatform.WINDOWS) {
      throw new Error('Init groups are not supported on Windows');
    }

    return {
      [this.groupName]: this.groupId !== undefined ? { gid: this.groupId } : {},
    };
  }

}

/**
 * Optional parameters used when creating a user
 */
interface InitUserOptions {
  /**
   * The user's home directory.
   */
  readonly homeDir?: string;

  /**
   * A user ID. The creation process fails if the user name exists with a different user ID.
   * If the user ID is already assigned to an existing user the operating system may
   * reject the creation request.
   */
  readonly userId?: number;

  /**
   * A list of group names. The user will be added to each group in the list.
   */
  readonly groups?: string[];
}

/**
 * Create Linux/UNIX users and to assign user IDs.
 *
 * Users are created as non-interactive system users with a shell of
 * /sbin/nologin. This is by design and cannot be modified.
 *
 * Not supported for Windows systems.
 */
export class InitUser extends InitElement {
  /**
   * Map a user name to a user id
   */
  public static fromName(userName: string, options: InitUserOptions = {}): InitUser {
    return new InitUser(userName, options);
  }

  public readonly elementType = InitElementType.USER;

  protected constructor(private readonly userName: string, private readonly userOptions: InitUserOptions) {
    super();
  }

  public renderElement(options: InitRenderOptions): Record<string, any> {
    if (options.platform === InitRenderPlatform.WINDOWS) {
      throw new Error('Init users are not supported on Windows');
    }

    return {
      [this.userName]: {
        uid: this.userOptions.userId,
        groups: this.userOptions.groups,
        homeDir: this.userOptions.homeDir,
      },
    };
  }

}

/**
 * A package to be installed during cfn-init time
 */
export class InitPackage extends InitElement {
  /**
   * Install an RPM from an HTTP URL or a location on disk
   */
  public static rpm(location: string, name?: string): InitPackage {
    return new InitPackage('rpm', [location], name);
  }

  /**
   * Install a package using Yum
   */
  public static yum(packageName: string, ...versions: string[]): InitPackage {
    return new InitPackage('yum', versions, packageName);
  }

  /**
   * Install a package from RubyGems
   */
  public static rubyGem(gemName: string, ...versions: string[]): InitPackage {
    return new InitPackage('rubygems', versions, gemName);
  }

  /**
   * Install a package from PyPI
   */
  public static python(packageName: string, ...versions: string[]): InitPackage {
    return new InitPackage('python', versions, packageName);
  }

  /**
   * Install a package using APT
   */
  public static apt(packageName: string, ...versions: string[]): InitPackage {
    return new InitPackage('apt', versions, packageName);
  }

  /**
   * Install an MSI package from an HTTP URL or a location on disk
   */
  public static msi(location: string, name?: string): InitPackage {
    return new InitPackage('msi', [location], name);
  }

  public readonly elementType = InitElementType.PACKAGE;

  protected constructor(private readonly type: string, private readonly versions: string[], private readonly packageName?: string) {
    super();
  }

  public renderElement(options: InitRenderOptions): Record<string, any> {
    if ((this.type === 'msi') !== (options.platform === InitRenderPlatform.WINDOWS)) {
      if (this.type === 'msi') {
        throw new Error('MSI installers are only supported on Windows systems.');
      } else {
        throw new Error('Windows only supports the MSI package type');
      }
    }

    if (!this.packageName && !['rpm', 'msi'].includes(this.type)) {
      throw new Error('Package name must be specified for all package types besides RPM and MSI.');
    }

    const packageName = this.packageName || (options.index + '').padStart(3, '0');

    return {
      [this.type]: {
        [packageName]: this.versions,
      },
    };
  }

}

/**
 * Options for an InitService
 */
export interface InitServiceOptions {
  /**
   * Enable or disable this service
   *
   * Set to true to ensure that the service will be started automatically upon boot.
   *
   * Set to false to ensure that the service will not be started automatically upon boot.
   *
   * @default - true if used in `InitService.enable()`, false if used in `InitService.disable()`,
   * no change to service state if used in `InitService.restart()`.
   */
  readonly enabled?: boolean;

  /**
   * Make sure this service is running or not running after cfn-init finishes.
   *
   * Set to true to ensure that the service is running after cfn-init finishes.
   *
   * Set to false to ensure that the service is not running after cfn-init finishes.
   *
   * @default - Same value as 'enabled'
   * no change to service state if used in `InitService.restart()`.
   */
  readonly ensureRunning?: boolean;

  /**
   * Restart service if cfn-init touches one of these files
   *
   * Only works for files listed in the `files` section.
   *
   * @default - No files trigger restart
   */
  readonly restartAfterFiles?: string[];

  /**
   * Restart service if cfn-init expands an archive into one of these directories.
   *
   * @default - No sources trigger restart
   */
  readonly restartAfterSources?: string[];

  /**
   * Restart service if cfn-init installs or updates one of these packages
   *
   * A map of package manager to list of package names.
   *
   * @default - No packages trigger restart
   */
  readonly restartAfterPackages?: Record<string, string[]>;

  /**
   * Restart service after cfn-init runs the given command
   *
   * Takes a list of command names.
   *
   * @default - No commands trigger restart
   */
  readonly restartAfterCommands?: string[];
}

/**
 * A services that be enabled, disabled or restarted when the instance is launched.
 */
export class InitService extends InitElement {
  /**
   * Enable and start the given service, optionally restarting it
   */
  public static enable(serviceName: string, options: InitServiceOptions = {}): InitService {
    const { enabled, ensureRunning, ...otherOptions } = options;
    return new InitService(serviceName, {
      enabled: true,
      ensureRunning: true,
      ...otherOptions,
    });
  }

  /**
   * Disable and stop the given service
   */
  public static disable(serviceName: string): InitService {
    return new InitService(serviceName, { enabled: false, ensureRunning: false });
  }

  /**
   * Create a service restart definition from the given options, not imposing any defaults.
   *
   * @param serviceName the name of the service to restart
   * @param options service options
   */
  public static fromOptions(serviceName: string, options: InitServiceOptions = {}): InitService {
    return new InitService(serviceName, options);
  }

  public readonly elementType = InitElementType.SERVICE;

  protected constructor(private readonly serviceName: string, private readonly serviceOptions: InitServiceOptions) {
    super();
  }

  public renderElement(options: InitRenderOptions): Record<string, any> {
    const serviceManager = options.platform === InitRenderPlatform.LINUX ? 'sysvinit' : 'windows';

    return {
      [serviceManager]: {
        [this.serviceName]: {
          enabled: this.serviceOptions.enabled,
          ensureRunning: this.serviceOptions.ensureRunning,
          files: this.serviceOptions.restartAfterFiles,
          sources: this.serviceOptions.restartAfterSources,
          commands: this.serviceOptions.restartAfterCommands,
          packages: this.serviceOptions.restartAfterPackages,
        },
      },
    };
  }

}

/**
 * Extract an archive into a directory
 */
export class InitSource extends InitElement {
  /**
   * Retrieve a URL and extract it into the given directory
   */
  public static fromUrl(targetDirectory: string, url: string): InitSource {
    return new InitSource(targetDirectory, url);
  }

  /**
   * Extract a GitHub branch into a given directory
   */
  public static fromGitHub(targetDirectory: string, owner: string, repo: string, refSpec?: string): InitSource {
    return InitSource.fromUrl(targetDirectory, `https://github.com/${owner}/${repo}/tarball/${refSpec ?? 'master'}`);
  }

  /**
   * Extract an archive stored in an S3 bucket into the given directory
   */
  public static fromS3Object(targetDirectory: string, bucket: s3.IBucket, key: string) {
    return InitSource.fromUrl(targetDirectory, bucket.urlForObject(key));
  }

  /**
   * Create an asset from the given directory and use that
   */
  public static fromDirectoryAsset(_targetDirectory: string, _sourceDirectory: string): InitSource {
    // TODO - No scope here, so can't create the Asset directly. Need to delay creation until bind() is called,
    // or find some other clever solution if we're going to support this.
    throw new Error('Not implemented');
  }

  /**
   * Extract a diretory from an existing directory asset
   */
  public static fromAsset(targetDirectory: string, asset: s3_assets.Asset): InitSource {
    return new InitSource(targetDirectory, asset.httpUrl, asset);
  }

  public readonly elementType = InitElementType.SOURCE;

  protected constructor(private readonly targetDirectory: string, private readonly url: string, private readonly asset?: s3_assets.Asset) {
    super();
  }

  public renderElement(_options: InitRenderOptions): Record<string, any> {
    return {
      [this.targetDirectory]: this.url,
    };
  }

  public bind(_scope: Construct, _options: InitBindOptions): void {
    if (this.asset === undefined) { return; }
    throw new Error('Not yet implemented');
  }
}