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
    }

    /**
     * Extend VSCode's environment by environment variables from Conan.
     *
     * @param conanEnv Which Conan environment to activate
     * @param pythonInterpreter Path to python interpreter
     * @param args Additional Conan arguments as given to `conan install`
     */
    public async activateEnvironment(conanEnv: ConanEnv, pythonInterpreter: string, args: string) {
        this.restoreEnvironment();
        const newenv = this.readEnvFromConan(conanEnv, pythonInterpreter, args);
        this.updateBackupEnvironment(newenv);

        this.updateVSCodeEnvironment(newenv);
        await this.context.workspaceState.update("vsconan.activeEnv", [conanEnv]);
        await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
        await this.outputChannel.appendLine(`Activate ${conanEnv}: ${JSON.stringify(newenv, null, 2)}`);
    }

    /**
     * Restore VSCode environment using backup.
     */
    public restoreEnvironment() {
        const backupEnv = this.context.workspaceState.get<EnvVars>("vsconan.backupEnv");
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
        newenv.forEach(([key, value]) => {
            if (backupEnv.has(key)) {
                newBackupEnv.push([key, value]);
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
    private readEnvFromConan(conanEnv: ConanEnv, pythonInterpreter: string, args: string): [string, string][] {
        const envScript = path.join(path.dirname(__dirname), '..', '..', '..', 'resources', 'print_env.py');
        let output = execSync(`${pythonInterpreter} ${envScript} ${conanEnv} ${args}`);
        return Object.entries(JSON.parse(`${output}`));
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

    public activeEnv(): ConanEnv | undefined {
        return this.context.workspaceState.get<[ConanEnv]>("vsconan.activeEnv")?.[0];
    }

}
