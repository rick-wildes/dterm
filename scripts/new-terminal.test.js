const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const repoDir = path.join(__dirname, '..');
const extensionPath = path.join(repoDir, 'out', 'extension.js');
const extensionSource = fs.readFileSync(extensionPath, 'utf8');
const requireExtension = createRequire(extensionPath);
const folders = [
    { name: 'first', index: 0, uri: { fsPath: '/workspace/first' } },
    { name: 'second', index: 1, uri: { fsPath: '/workspace/second root', scheme: 'vscode-remote' } },
];

function createHarness(workspaceFolders, selectedFolder) {
    const calls = { picks: 0, allocations: 0, bootstraps: [], terminals: [], messages: [] };
    const commands = new Map();
    const disposable = () => ({ dispose() {} });
    let profile;
    const vscode = {
        env: { machineId: 'test-client' },
        ExtensionMode: { Development: 2 },
        EventEmitter: class {
            event = disposable;
            fire() {}
            dispose() {}
        },
        TerminalProfile: class {
            constructor(options) { this.options = options; }
        },
        ThemeColor: class {},
        Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }) },
        workspace: {
            workspaceFolders,
            getConfiguration: () => ({ get: (_key, fallback) => fallback }),
            onDidChangeConfiguration: disposable,
            onDidChangeWorkspaceFolders: disposable,
        },
        commands: {
            registerCommand(id, handler) {
                commands.set(id, handler);
                return disposable();
            },
        },
        window: {
            terminals: [],
            tabGroups: { all: [], onDidChangeTabs: disposable, onDidChangeTabGroups: disposable },
            onDidChangeActiveTerminal: disposable,
            onDidOpenTerminal: disposable,
            onDidCloseTerminal: disposable,
            onDidChangeTerminalState: disposable,
            onDidEndTerminalShellExecution: disposable,
            onDidChangeTerminalShellIntegration: disposable,
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            registerTerminalProfileProvider(_id, provider) {
                profile = provider;
                return disposable();
            },
            async showWorkspaceFolderPick() {
                calls.picks++;
                return selectedFolder;
            },
            createTerminal(options) {
                const terminal = { creationOptions: options, shown: false, show() { this.shown = true; } };
                calls.terminals.push(terminal);
                return terminal;
            },
        },
    };
    const context = vm.createContext({
        exports: {},
        process: { ...process, env: { SHELL: '/bin/bash' } },
        Buffer,
        calls,
        socket: {
            on() { return this; },
            write(message) { calls.messages.push(JSON.parse(message)); },
        },
        require(id) {
            if (id === 'vscode') return vscode;
            if (id === './client') {
                return { userSystemdAvailable: () => false, setSystemdRunLingerPrompt() {} };
            }
            return requireExtension(id);
        },
    });
    vm.runInContext(extensionSource, context, { filename: extensionPath });
    vm.runInContext(`
        ensureNodePty = async () => true;
        pushAllDaemonSettings = async () => {};
        ensureClientId = async () => {};
        checkDaemonVersion = async () => ({ restarted: true });
        refreshManagedSockets = () => ({});
        allocateSessionName = async () => 'test-session-' + ++calls.allocations;
        bootstrapShell = async (sessionName, cwd, nonce) => {
            calls.bootstraps.push(buildBootstrapStubOptions(sessionName, '/test/bootstrap.sock', cwd, nonce));
            return { env: { VSCODE_NONCE: nonce }, args: ['node', 'stub', '--init-file', 'integration.sh'] };
        };
        connectToDaemon = async () => socket;
    `, context);
    context.exports.activate({
        extensionPath: repoDir,
        extensionUri: { fsPath: repoDir },
        extensionMode: 1,
        extension: { packageJSON: { version: 'test' } },
        subscriptions: [],
    });
    return { calls, commands, profile, vscode, context };
}

async function openTerminal(options) {
    options.pty.open({ columns: 100, rows: 30 });
    await new Promise(setImmediate);
}

test('the new-terminal command is contributed to the Command Palette', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
    assert.ok(manifest.contributes.commands.some(command => command.command === 'dterm.newTerminal'));
});

test('a non-first multi-root folder reaches both the bootstrap and daemon', async () => {
    const { calls, commands, vscode } = createHarness(folders, folders[1]);
    await commands.get('dterm.newTerminal')();
    vscode.workspace.workspaceFolders = [folders[0]];
    assert.equal(calls.picks, 1);
    assert.equal(calls.bootstraps[0].cwd, folders[1].uri.fsPath);
    assert.equal(calls.terminals.length, 1);
    assert.equal(calls.terminals[0].shown, true);
    const options = calls.terminals[0].creationOptions;
    await openTerminal(options);
    assert.equal(calls.messages[0].cwd, folders[1].uri.fsPath);
    assert.equal(calls.messages[0].name, calls.bootstraps[0].env.DTERM_SESSION);
    assert.equal(calls.messages[0].env.VSCODE_NONCE, options.shellIntegrationNonce);
    assert.equal(calls.bootstraps[0].shellIntegrationNonce, options.shellIntegrationNonce);
    assert.deepEqual(calls.messages[0].shellArgs, ['--init-file', 'integration.sh']);
});

test('cancelling the folder picker does not allocate or launch a session', async () => {
    const { calls, commands } = createHarness(folders, undefined);
    await commands.get('dterm.newTerminal')();
    assert.deepEqual(calls, { picks: 1, allocations: 0, bootstraps: [], terminals: [], messages: [] });
});

test('a single-folder workspace launches without prompting', async () => {
    const { calls, commands } = createHarness([folders[0]]);
    await commands.get('dterm.newTerminal')();
    await openTerminal(calls.terminals[0].creationOptions);
    assert.equal(calls.picks, 0);
    assert.equal(calls.bootstraps[0].cwd, folders[0].uri.fsPath);
    assert.equal(calls.messages[0].cwd, folders[0].uri.fsPath);
});

for (const workspaceFolders of [undefined, []]) {
    test(`no workspace (${JSON.stringify(workspaceFolders)}) keeps the default cwd without prompting`, async () => {
        const { calls, commands } = createHarness(workspaceFolders);
        await commands.get('dterm.newTerminal')();
        await openTerminal(calls.terminals[0].creationOptions);
        assert.equal(calls.picks, 0);
        assert.equal(calls.bootstraps[0].cwd, undefined);
        assert.equal(calls.messages[0].cwd, undefined);
    });
}

test('each invocation launches a fresh terminal', async () => {
    const { calls, commands } = createHarness(folders, folders[1]);
    await commands.get('dterm.newTerminal')();
    await commands.get('dterm.newTerminal')();
    assert.equal(calls.allocations, 2);
    assert.equal(calls.terminals.length, 2);
    assert.notEqual(calls.bootstraps[0].env.DTERM_SESSION, calls.bootstraps[1].env.DTERM_SESSION);
});

test('the existing profile still uses the shared launch path without prompting', async () => {
    const { calls, profile } = createHarness(folders);
    const terminalProfile = await profile.provideTerminalProfile();
    await openTerminal(terminalProfile.options);
    assert.equal(calls.picks, 0);
    assert.equal(calls.bootstraps[0].cwd, folders[0].uri.fsPath);
    assert.equal(calls.messages[0].cwd, folders[0].uri.fsPath);
});

test('reattach still omits cwd and shell configuration', async () => {
    const { calls, context } = createHarness(folders);
    const options = vm.runInContext(
        "buildPseudoOptions('existing', undefined, undefined, { cols: 80, rows: 24 }, undefined, true, undefined)",
        context,
    );
    await openTerminal(options);
    assert.deepEqual(calls.messages, [{ type: 'open', name: 'existing', cols: 100, rows: 30 }]);
    assert.equal(calls.bootstraps.length, 0);
});