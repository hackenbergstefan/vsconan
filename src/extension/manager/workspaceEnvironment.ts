import { execSync } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as utils from '../../utils/utils';
import { SettingsPropertyManager } from '../settings/settingsPropertyManager';
import path = require('path');

/**
 * Shorthand type for Array of "key=value" pairs of environment variables.
 */
type EnvVars = Array<[string, string | undefined]>;

/**
 * Enum to distinguish between different Conan environments.
 */
export enum ConanEnv {
    buildEnv = "BuildEnv",
    runEnv = "RunEnv"
}

/**
 * Manage VSCode's process and terminal environment.
 */
export class VSConanWorkspaceEnvironment {
    private context: vscode.ExtensionContext;
    private settingsPropertyManager: SettingsPropertyManager;
    private outputChannel: vscode.OutputChannel;

    public constructor(context: vscode.ExtensionContext, settingsPropertyManager: SettingsPropertyManager, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.settingsPropertyManager = settingsPropertyManager;
        this.outputChannel = outputChannel;

        const activeEnv = this.activeEnv();
        if (activeEnv) {
            this.updateVSCodeEnvironment(activeEnv[2]);
        }
    }

    /**
     * Extend VSCode's environment by environment variables from Conan.
     *
     * @param conanEnv Which Conan environment to activate
     * @param configName Config name
     * @param pythonInterpreter Path to python interpreter
     * @param args Additional Conan arguments as given to `conan install`
     */
    public async activateEnvironment(conanEnv: ConanEnv, configName: string, pythonInterpreter: string, args: string) {
        this.restoreEnvironment();
        var newenv = await this.readEnvFromConan(conanEnv, pythonInterpreter, args);
        this.updateBackupEnvironment(newenv);

        this.updateVSCodeEnvironment(newenv);
        await this.context.workspaceState.update("vsconan.activeEnv", [configName, conanEnv, newenv]);
        if (vscode.env.remoteName === undefined) {
            await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
        } else {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
        await this.outputChannel.appendLine(`Activate ${conanEnv}: ${JSON.stringify(newenv, null, 2)}`);
        await vscode.window.showInformationMessage(`Activated Environment ${configName}[${conanEnv}]`);
    }

    /**
     * Restore VSCode environment using backup.
     */
    public restoreEnvironment() {
        const backupEnv = this.context.workspaceState.get<EnvVars>("vsconan.backupEnv");
        console.log(`[vsconan] restoreEnvironment: ${backupEnv}`);
        if (backupEnv) {
            this.updateVSCodeEnvironment(backupEnv);
        }
        this.updateDotEnvFile([]);
        this.context.workspaceState.update("vsconan.activeEnv", undefined);
    }

    /**
     * Update backup environment by saving all _current_ environment variables
     * which would be modified by `newenv`.
     *
     * @param newenv New environment. Not the backup!
     */
    private updateBackupEnvironment(newenv: EnvVars) {
        let backupEnv = new Map(this.context.workspaceState.get<EnvVars>("vsconan.backupEnv"));
        let newBackupEnv: EnvVars = [];
        newenv.forEach(([key, _]) => {
            if (backupEnv.has(key)) {
                newBackupEnv.push([key, backupEnv.get(key)]);
            } else {
                // TODO: Take really from process env??
                newBackupEnv.push([key, process.env[key]]);
            }
        });
        this.context.workspaceState.update("vsconan.backupEnv", newBackupEnv);
        console.log(`[vsconan] updateBackupEnvironment: ${newBackupEnv}`);
    }

    /**
     * Update VSCode's process and terminal environment.
     *
     * @param data Environment variables to apply
     * @param additionalPATH Additional entries to prepend to PATH
     */
    private updateVSCodeEnvironment(data: EnvVars) {
        console.log(`[vsconan] updateVSCodeEnvironment: ${data}`);
        data.forEach(([key, value]) => {
            if (!value) {
                delete process.env[key];
                this.context.environmentVariableCollection.delete(key);
            } else {
                process.env[key] = value;
                this.context.environmentVariableCollection.replace(key, value);
            }
        });

        this.updateDotEnvFile(data);
    }

    /**
     * Read environment variables from Conan's VirtualBuildEnv/VirtualRunEnv.
     *
     * @param conanEnv Which environment to generate
     * @param pythonInterpreter Path to python interpreter
     * @param args Additional Conan arguments as given to `conan install`
     * @returns Array of environment settings
     */
    private async readEnvFromConan(conanEnv: ConanEnv, pythonInterpreter: string, args: string): Promise<[string, string][]> {
        const envScript = path.join(path.dirname(__dirname), '..', '..', '..', 'resources', 'print_env.py');
        const options = { 'timeout': 20000, 'cwd': vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined };

        const cmd = `${pythonInterpreter} ${envScript} ${conanEnv} ${args}`;
        await this.outputChannel.appendLine(`Executing "${cmd}" with "${JSON.stringify(options)}"`);
        try {
            const output = execSync(cmd, options);
            let parsed = JSON.parse(`${output}`);
            parsed['PATH'] = `${path.dirname(pythonInterpreter)}${path.delimiter}${parsed['PATH']}`;
            return Object.entries(parsed);
        } catch (err) {
            vscode.window.showErrorMessage((err as Error).message);
            throw err;
        }
    }

    /**
     * Update `.env`-File in current Workspace if option is selected.
     *
     * @param data New content
     */
    private updateDotEnvFile(data: EnvVars) {
        if (this.settingsPropertyManager.isUpdateDotEnv() !== true) {
            return;
        }
        let ws = utils.workspace.selectWorkspace();
        ws.then(result => {
            const dotenv = path.join(String(result), ".env");
            const content = data.map(([key, value]) => {
                return `${key}=${value}`;
            }).join('\n');
            fs.writeFileSync(dotenv, content);
        }).catch(reject => {
            vscode.window.showInformationMessage("No workspace detected.");
        });
    }

    public activeEnv(): [string, ConanEnv, [string, string][]] | undefined {
        return this.context.workspaceState.get<[string, ConanEnv, [string, string][]]>("vsconan.activeEnv");
    }

}
