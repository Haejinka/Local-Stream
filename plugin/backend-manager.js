(function (root) {
  const EXTENSION_ID = 'com.localstream.premiere';
  let connectionTask = null;

  function runtime() {
    const bridge = root.cep_node;
    if (!bridge || typeof bridge.require !== 'function' || !bridge.process) return null;
    try {
      const nodeRequire = bridge.require;
      return {
        childProcess: nodeRequire('child_process'),
        fs: nodeRequire('fs'),
        path: nodeRequire('path'),
        process: bridge.process
      };
    } catch { return null; }
  }

  function appDataDirectory(node) {
    const env = node?.process?.env || {};
    if (node && env.LOCALAPPDATA) return node.path.join(env.LOCALAPPDATA, 'Adobe', 'CEP', 'extensionsData', EXTENSION_ID);
    if (node && env.USERPROFILE) return node.path.join(env.USERPROFILE, 'AppData', 'Local', 'Adobe', 'CEP', 'extensionsData', EXTENSION_ID);
    const profile = profileFromExtensionPath();
    return profile ? `${profile.replace(/\\/g, '/')}/AppData/Local/Adobe/CEP/extensionsData/${EXTENSION_ID}` : '';
  }

  function extensionPath() {
    try {
      if (root.CSInterface && root.SystemPath) {
        const path = new root.CSInterface().getSystemPath(root.SystemPath.EXTENSION);
        if (path) return path;
      }
    } catch { }
    try {
      const path = root.__adobe_cep__?.getSystemPath?.('extension');
      if (path) return decodeURI(path).replace(/^\/?([A-Za-z]:)/, '$1').replace(/\//g, '\\');
    } catch { }
    return '';
  }

  function profileFromExtensionPath() {
    const normalized = extensionPath().replace(/\//g, '\\');
    const match = /^(.*)\\AppData\\Roaming\\Adobe\\CEP\\extensions\\[^\\]+$/i.exec(normalized);
    return match ? match[1] : '';
  }

  function legacyAppDataDirectory(node) {
    const env = node?.process?.env || {};
    if (node && env.LOCALAPPDATA) return node.path.join(env.LOCALAPPDATA, 'LocalStream');
    if (node && env.USERPROFILE) return node.path.join(env.USERPROFILE, 'AppData', 'Local', 'LocalStream');
    const profile = profileFromExtensionPath();
    return profile ? `${profile.replace(/\\/g, '/')}/AppData/Local/LocalStream` : '';
  }

  function readWithCepFs(file) {
    try {
      const result = root.cep?.fs?.readFile?.(file);
      return result?.err === 0 ? String(result.data || '').replace(/^\uFEFF/, '').trim() : '';
    } catch { return ''; }
  }

  function readText(node, file) {
    try { return node.fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim(); }
    catch { return ''; }
  }

  function tokenFromDisk(node) {
    const directories = [appDataDirectory(node), legacyAppDataDirectory(node)].filter(Boolean);
    for (const directory of directories) {
      const file = node ? node.path.join(directory, 'auth-token.txt') : `${directory.replace(/\\/g, '/')}/auth-token.txt`;
      const token = (node ? readText(node, file) : '') || readWithCepFs(file);
      if (token.length >= 32) return token;
    }
    return '';
  }

  function nodeCandidates(node) {
    const env = node.process.env || {};
    const toolsRoots = [appDataDirectory(node), legacyAppDataDirectory(node)]
      .filter(Boolean)
      .map((directory) => node.path.join(directory, 'tools'));
    const candidates = [
      ...toolsRoots.map((tools) => readText(node, node.path.join(tools, 'node-path.txt'))),
      ...toolsRoots.map((tools) => node.path.join(tools, 'node', 'node.exe')),
      env.ProgramFiles && node.path.join(env.ProgramFiles, 'nodejs', 'node.exe'),
      env['ProgramFiles(x86)'] && node.path.join(env['ProgramFiles(x86)'], 'nodejs', 'node.exe'),
      env.LOCALAPPDATA && node.path.join(env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'),
      ...(env.PATH || '').split(node.path.delimiter).map((directory) => node.path.join(directory, 'node.exe'))
    ].filter(Boolean);

    const seen = new Set();
    return candidates.filter((candidate) => {
      const normalized = node.path.normalize(candidate).toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      try { return node.fs.existsSync(candidate) && node.fs.statSync(candidate).isFile(); }
      catch { return false; }
    });
  }

  function usableNode(node, executable) {
    try {
      const version = node.childProcess.execFileSync(executable, ['--version'], {
        encoding: 'utf8', windowsHide: true, timeout: 5000
      }).trim();
      const match = /^v?(\d+)\./.exec(version);
      return Boolean(match && Number(match[1]) >= 20);
    } catch { return false; }
  }

  function findNode(node) {
    return nodeCandidates(node).find((candidate) => usableNode(node, candidate)) || '';
  }

  async function isBackendReady(apiBase) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await fetch(`${apiBase}/api/health`, {
        credentials: 'omit', cache: 'no-store', signal: controller.signal
      });
      if (!response.ok) return false;
      const health = await response.json();
      return health.name === 'Local Stream' && health.ready === true;
    } catch { return false; }
    finally { clearTimeout(timer); }
  }

  async function waitForBackend(apiBase, attempts) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await isBackendReady(apiBase)) return true;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return false;
  }

  async function connect(options) {
    if (connectionTask) return connectionTask;
    connectionTask = (async () => {
      const apiBase = options.apiBase;
      let node = runtime();
      if (await isBackendReady(apiBase)) {
        const token = tokenFromDisk(node);
        return { running: true, token: token || options.token || '' };
      }

      if (!node) throw new Error('Automatic backend startup is unavailable in this CEP session. Reinstall the panel and restart Premiere.');
      const executable = findNode(node);
      if (!executable) throw new Error('Local Stream could not find Node.js 20 or later. Run the Local Stream installer to set it up automatically.');

      const extensionRoot = extensionPath();
      if (!extensionRoot) throw new Error('Premiere did not provide the Local Stream extension folder. Reinstall the panel and restart Premiere.');
      const serverFile = node.path.join(extensionRoot, 'backend', 'server.mjs');
      if (!node.fs.existsSync(serverFile)) throw new Error('The Local Stream backend files are missing. Run the Local Stream installer and restart Premiere.');

      const parsed = new URL(apiBase);
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The Local Stream backend address has an invalid port.');

      const env = { ...(node.process.env || {}), LOCAL_STREAM_PORT: String(port) };
      delete env.LOCAL_STREAM_TOKEN;
      delete env.LOCAL_STREAM_DATA_DIR;
      const child = node.childProcess.spawn(executable, [serverFile], {
        cwd: node.path.dirname(serverFile),
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env
      });
      child.unref();

      if (!await waitForBackend(apiBase, 35)) {
        throw new Error('Local Stream could not start its backend. Check that the configured port is free, then reopen the panel.');
      }

      node = runtime();
      const token = tokenFromDisk(node);
      if (!token && !options.token) throw new Error('Local Stream started, but could not read its local authentication token. Reinstall the panel and restart Premiere.');
      return { running: true, token: token || options.token || '' };
    })().finally(() => { connectionTask = null; });
    return connectionTask;
  }

  root.LocalStreamBackend = { connect };
})(window);
