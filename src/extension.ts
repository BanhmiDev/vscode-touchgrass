// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

const enum ExtensionPosition {
    explorer = 'explorer',
    panel = 'panel'
}

const DEFAULT_POSITION = ExtensionPosition.panel;

function getConfigurationPosition() {
    return vscode.workspace
        .getConfiguration('vscode-touchgrass')
        .get<ExtensionPosition>('position', DEFAULT_POSITION);
}

function updateExtensionPositionContext() {
    vscode.commands.executeCommand(
        'setContext',
        'vscode-touchgrass.position',
        getConfigurationPosition(),
    );
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	const webViewProvider = new TouchGrassProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            TouchGrassProvider.viewType,
            webViewProvider,
        ),
    );
	// Immediate update
    updateExtensionPositionContext();

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-touchgrass.start', () => {
			if (getConfigurationPosition() === ExtensionPosition.explorer && webViewProvider) {
                vscode.commands.executeCommand('touchGrassView.focus');
            } else {
				TouchGrassPanel.createOrShow(context.extensionUri);
			}
		})
	);
	
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(
            updateExtensionPositionContext,
        ),
    );

	if (vscode.window.registerWebviewPanelSerializer) {
		// Make sure we register a serializer in activation event
		vscode.window.registerWebviewPanelSerializer(TouchGrassPanel.viewType, {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
				// Reset the webview options so we use latest uri for `localResourceRoots`.
				webviewPanel.webview.options = getWebviewOptions(context.extensionUri);
				TouchGrassPanel.revive(webviewPanel, context.extensionUri);
			}
		});
	}
}

function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
	return {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'node_modules'), vscode.Uri.joinPath(extensionUri, 'media')]
	};
}

// This method is called when your extension is deactivated
export function deactivate() {}

/**
 * Webview container shared for panel and explorer view
 */
class TouchGrassWebViewContainer {
	
    protected _extensionUri: vscode.Uri;

	constructor(
        extensionUri: vscode.Uri
    ) {
        this._extensionUri = extensionUri;
	}

	protected _getHtmlForWebview(webview: vscode.Webview) {
		const toolkitUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/webview-ui-toolkit', 'dist', 'toolkit.js'));

		// Local path to main script run in the webview
		const scriptPathOnDisk = vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js');

		// And the uri we use to load this script in the webview
		const scriptUri = webview.asWebviewUri(scriptPathOnDisk);

		// Grass image
		const grassImgPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'grass.png');
		const grassImgSrc = webview.asWebviewUri(grassImgPath);

		// Local path to css styles
		const styleResetPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css');
		const stylesPathMainPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css');

		// Uri to load styles into webview
		const stylesResetUri = webview.asWebviewUri(styleResetPath);
		const stylesMainUri = webview.asWebviewUri(stylesPathMainPath);

		// Use a nonce to only allow specific scripts to be run
		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<!--
					Use a content security policy to only allow loading images from https or from our extension directory,
					and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${stylesResetUri}" rel="stylesheet">
				<link href="${stylesMainUri}" rel="stylesheet">
				<script type="module" nonce="${nonce}" src="${toolkitUri}"></script>
				<title>Touching Grass</title>
			</head>
			<body>
				<img src="${grassImgSrc}" height="100" />
				<h2>Touched grass <span id="lines-of-code-counter">0</span>x this session</h2>
				<div id="touch-grass-container">
					<vscode-button appearance="primary" id="touch-grass-add">Touch Grass</vscode-button><vscode-button appearance="secondary" id="touch-grass-reset">Reset</vscode-button>
				</div>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}

/**
 * Manages webview panel
 */
class TouchGrassPanel extends TouchGrassWebViewContainer {
	
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel: TouchGrassPanel | undefined;

	public static readonly viewType = 'touchGrassCoding';

	private readonly _panel: vscode.WebviewPanel;
	private _disposables: vscode.Disposable[] = [];

	public static createOrShow(extensionUri: vscode.Uri) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		// If we already have a panel, show it.
		if (TouchGrassPanel.currentPanel) {
			TouchGrassPanel.currentPanel._panel.reveal(column);
			return;
		}

		// Otherwise, create a new panel.
		const panel = vscode.window.createWebviewPanel(
			TouchGrassPanel.viewType,
			'Touch Grass',
			column || vscode.ViewColumn.Two,
			getWebviewOptions(extensionUri),
		);

		TouchGrassPanel.currentPanel = new TouchGrassPanel(panel, extensionUri);
	}

	public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		TouchGrassPanel.currentPanel = new TouchGrassPanel(panel, extensionUri);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		super(extensionUri);

		this._panel = panel;

		// Set the webview's initial html content
		this._update();

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programmatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Update the content based on view changes
		this._panel.onDidChangeViewState(
			e => {
				if (this._panel.visible) {
					this._update();
				}
			},
			null,
			this._disposables
		);

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(
			message => {
				switch (message.command) {
					case "touchgrass":
						vscode.window.showInformationMessage(message.text);
						return;
					case 'alert':
						vscode.window.showErrorMessage(message.text);
						return;
				}
			},
			null,
			this._disposables
		);
	}

	public dispose() {
		TouchGrassPanel.currentPanel = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	private _update() {
		const webview = this._panel.webview;
		this._panel.webview.html = this._getHtmlForWebview(webview);
	}
	
    public getWebview(): vscode.Webview {
        return this._panel.webview;
    }
}

/**
 * Manages webview side panel
 */
class TouchGrassProvider extends TouchGrassWebViewContainer implements vscode.WebviewViewProvider {

	public static readonly viewType = 'touchGrassView';

	private _view?: vscode.WebviewView;

	constructor(
		private readonly extensionUri: vscode.Uri,
	) { 
		super(extensionUri);
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(data => {
			switch (data.type) {
				case 'colorSelected':
					{
						vscode.window.activeTextEditor?.insertSnippet(new vscode.SnippetString(`#${data.value}`));
						break;
					}
			}
		});
	}

	public addColor() {
		if (this._view) {
			this._view.show?.(true); // `show` is not implemented in 1.49 but is for 1.50 insiders
			this._view.webview.postMessage({ type: 'addColor' });
		}
	}

	public clearColors() {
		if (this._view) {
			this._view.webview.postMessage({ type: 'clearColors' });
		}
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}