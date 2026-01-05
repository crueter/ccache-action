import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import * as core from "@actions/core";
import * as io from "@actions/io";
import * as exec from "@actions/exec";
import * as process from "process";
import * as cache from "@actions/cache";
import { cacheDir } from "./common";

const CCACHE_VERSION: string = "4.12.2"
const SCCACHE_VERSION: string = "v0.12.0"

const SELF_CI = process.env["CCACHE_ACTION_CI"] === "true"

function getPackageManagerError(error: Error | unknown) : string {
  return (
    `Failed to install ccache via package manager: '${error}'. ` +
    "Perhaps package manager index is not up to date? " +
    "(either update it manually before running ccache-action or set 'update-package-index' option to 'true')"
  );
}

// based on https://cristianadam.eu/20200113/speeding-up-c-plus-plus-github-actions-using-ccache/

async function restore(ccacheVariant : string) : Promise<void> {
  const inputs = {
    primaryKey: core.getInput("key"),
    // https://github.com/actions/cache/blob/73cb7e04054996a98d39095c0b7821a73fb5b3ea/src/utils/actionUtils.ts#L56
    restoreKeys: core.getInput("restore-keys").split("\n").map(s => s.trim()).filter(x => x !== ""),
    appendTimestamp: core.getInput("append-timestamp")
  };

  const keyPrefix = ccacheVariant + "-";
  const primaryKey = inputs.primaryKey ? keyPrefix + (inputs.appendTimestamp ? inputs.primaryKey + "-" : inputs.primaryKey) : keyPrefix;
  const restoreKeys = inputs.restoreKeys.map(k => keyPrefix + k + (inputs.appendTimestamp ? "-" : ""));
  const paths = [cacheDir(ccacheVariant)];
  
  core.saveState("primaryKey", primaryKey);

  const shouldRestore = core.getBooleanInput("restore");
  if (!shouldRestore) {
    core.info("Restore set to false, skip restoring cache.");
    return;
  }
  const restoredWith = await cache.restoreCache(paths, primaryKey, restoreKeys);
  if (restoredWith) {
    core.info(`Restored from cache key "${restoredWith}".`);
    if (SELF_CI) {
      core.setOutput("test-cache-hit", true)
    }
  } else {
    core.info("No cache found.");
    if (SELF_CI) {
      core.setOutput("test-cache-hit", false)
    }
  }
}

async function configure(ccacheVariant : string, platform : string) : Promise<void> {
  const maxSize = core.getInput('max-size');
  
  if (ccacheVariant === "ccache") {
    await execShell(`ccache --set-config=cache_dir='${cacheDir(ccacheVariant)}'`);
    await execShell(`ccache --set-config=max_size='${maxSize}'`);
    await execShell(`ccache --set-config=compression=true`);
    if (platform === "darwin" || platform === "win32") {
      // On Windows mtime will be different depending on the Visual Studio installation time, making it unreliable.
      await execShell(`ccache --set-config=compiler_check=content`);
    }
    if (core.getBooleanInput("create-symlink")) {
      const ccache = await io.which("ccache");
      await execShell(`ln -s ${ccache} /usr/local/bin/gcc`);
      await execShell(`ln -s ${ccache} /usr/local/bin/g++`);
      await execShell(`ln -s ${ccache} /usr/local/bin/cc`);
      await execShell(`ln -s ${ccache} /usr/local/bin/c++`);
      await execShell(`ln -s ${ccache} /usr/local/bin/clang`);
      await execShell(`ln -s ${ccache} /usr/local/bin/clang++`);
      await execShell(`ln -s ${ccache} /usr/local/bin/emcc`);
      await execShell(`ln -s ${ccache} /usr/local/bin/em++`);
    }
    core.info("Ccache config:");
    await execShell("ccache -p");
  } else {
    const options = `SCCACHE_IDLE_TIMEOUT=0 SCCACHE_DIR='${cacheDir(ccacheVariant)}' SCCACHE_CACHE_SIZE='${maxSize}'`;
    await execShell(`env ${options} sccache --start-server`);
  }

}

async function installCcacheMac() : Promise<void> {
  if (core.getBooleanInput("update-package-index")) {
    await execShell("brew update");
  }
  try {
    await execShell("brew install ccache");
  } catch (error) {
    throw new Error(getPackageManagerError(error));
  }
}

async function installCcacheLinux() : Promise<void> {
  const shouldUpdate = core.getBooleanInput("update-package-index");
  try {
    if (await io.which("apt-get")) {
      if (shouldUpdate) {
        await execShellSudo("apt-get update");
      }
      await execShellSudo("apt-get install -y ccache");
      return;
    } else if (await io.which("apk")) {
      if (shouldUpdate) {
        await execShell("apk update");
      }
      await execShell("apk add ccache");
      return;
    } else if (await io.which("dnf")) {
      if (shouldUpdate) {
        await execShell("dnf check-update");
      }
      // ccache is part of EPEL repo.
      await execShell("dnf install -y epel-release");
      await execShell("dnf install -y ccache");
      return;
    }
  } catch (error) {
    throw new Error(getPackageManagerError(error));
  }

  throw Error("Can't install ccache automatically under this platform, please install it yourself before using this action.");
}

async function installCcacheWindows() : Promise<void> {
  let packageName: string;
  let sha256: string;
  switch (process.arch) {
    case "x64":
      packageName = "windows-x86_64";
      sha256 = "bd73f405e3e80c7f0081ee75dbf9ee44dee64ecfbc3d4316e9a4ede4832f2e41";
      break;
    case "arm64":
      packageName = "windows-aarch64";
      sha256 = "9881a3acf40a5b22eff1c1650b335bd7cf56cf66a6c05cb7d0f53f19b43054f8"
      break;
    default:
      throw new Error(`Unsupported architecture: ${process.arch}`);
  }

  await installCcacheFromGitHub(
    packageName,
    // sha256sum of ccache.exe
    sha256,
    // TODO find a better place
    `${process.env.USERPROFILE}\\.cargo\\bin`,
    "ccache.exe"
  );
}

async function installSccacheMac() : Promise<void> {
  await execShell("brew install sccache");
}

async function installSccacheLinux() : Promise<void> {
  let packageArch: string;
  let sha256: string;
  switch (process.arch) {
    case "x64":
      packageArch = "x86_64"
      sha256 = "e381a9675f971082a522907b8381c1054777ea60511043e4c67de5dfddff3029";
      break;
    case "arm64":
      packageArch = "aarch64";
      sha256 = "2f9a8af7cea98e848f92e865a6d5062cfb8c91feeef17417cdd43276b4c7d8af"
      break;
    default:
      throw new Error(`Unsupported architecture: ${process.arch}`);
  }

  let packageName: string = `${packageArch}-unknown-linux-musl`
  
  await installSccacheFromGitHub(
    packageName,
    sha256,
    "/usr/local/bin/",
    "sccache"
  );
}

async function installSccacheWindows() : Promise<void> {
  let packageArch: string;
  let sha256: string;
  switch (process.arch) {
    case "x64":
      packageArch = "x86_64"
      sha256 = "b0236d379a66b22f6bc9e944adb5b354163015315c3a2aaf7803ce2add758fcd";
      break;
    case "arm64":
      packageArch = "aarch64";
      sha256 = "0254597932dcc4fa85f67ac149be29941b96a19f8b1bb0bf71b24640641ab987"
      break;
    default:
      throw new Error(`Unsupported architecture: ${process.arch}`);
  }

  let packageName: string = `${packageArch}-pc-windows-msvc`

  await installSccacheFromGitHub(
    packageName,
    sha256,

    // TODO find a better place
    `${process.env.USERPROFILE}\\.cargo\\bin`,
    "sccache.exe"
  );
}

async function execShell(cmd : string) {
  await exec.exec("sh", ["-xc", cmd]);
}

async function execShellSudo(cmd : string) {
  await execShell("$(which sudo) " + cmd);
}

async function installCcacheFromGitHub(artifactName : string, binSha256 : string, binDir : string, binName : string) : Promise<void> {
  const archiveName = `ccache-${CCACHE_VERSION}-${artifactName}`;
  const url = `https://github.com/ccache/ccache/releases/download/v${CCACHE_VERSION}/${archiveName}.zip`;
  const binPath = path.join(binDir, binName);
  await downloadAndExtract(url, path.join(archiveName, binName), binPath);
  checkSha256Sum(binPath, binSha256);
  core.addPath(binDir);
}

async function installSccacheFromGitHub(version : string, artifactName : string, binSha256 : string, binDir : string, binName : string) : Promise<void> {
  const archiveName = `sccache-${SCCACHE_VERSION}-${artifactName}`;
  const url = `https://github.com/mozilla/sccache/releases/download/${SCCACHE_VERSION}/${archiveName}.tar.gz`;
  const binPath = path.join(binDir, binName);
  await downloadAndExtract(url, `*/${binName}`, binPath);
  checkSha256Sum(binPath, binSha256);
  core.addPath(binDir);
  await execShell(`chmod +x '${binPath}'`);
}

async function downloadAndExtract (url : string, srcFile : string, dstFile : string) {
  const dstDir = path.dirname(dstFile);
  if (!fs.existsSync(dstDir)) {
    fs.mkdirSync(dstDir, { recursive: true });
  }
  if (url.endsWith(".zip")) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), ""));
    const zipName = path.join(tmp, "dl.zip");
    await execShell(`curl -L '${url}' -o '${zipName}'`);
    await execShell(`unzip '${zipName}' -d '${tmp}'`);
    fs.copyFileSync(path.join(tmp, srcFile), dstFile);
    fs.rmSync(tmp, { recursive: true });
  } else {
    await execShell(`curl -L '${url}' | tar xzf - -O --wildcards '${srcFile}' > '${dstFile}'`);
  }
}

function checkSha256Sum (path : string, expectedSha256 : string) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(path));
  const actualSha256 = h.digest("hex");
  if (actualSha256  !== expectedSha256) {
    throw Error(`SHA256 of ${path} is ${actualSha256}, expected ${expectedSha256}`);
  }
}

async function runInner() : Promise<void> {
  const ccacheVariant = core.getInput("variant");
  core.saveState("startTimestamp", Date.now());
  core.saveState("ccacheVariant", ccacheVariant);
  core.saveState("evictOldFiles", core.getInput("evict-old-files"));
  core.saveState("shouldSave", core.getBooleanInput("save"));
  core.saveState("appendTimestamp", core.getBooleanInput("append-timestamp"));
  let ccachePath = await io.which(ccacheVariant);
  if (!ccachePath) {
    core.startGroup(`Install ${ccacheVariant}`);
    const installer = {
      ["ccache,linux"]: installCcacheLinux,
      ["ccache,darwin"]: installCcacheMac,
      ["ccache,win32"]: installCcacheWindows,
      ["sccache,linux"]: installSccacheLinux,
      ["sccache,darwin"]: installSccacheMac,
      ["sccache,win32"]: installSccacheWindows,
    }[[ccacheVariant, process.platform].join()];
    if (!installer) {
      throw Error(`Unsupported platform: ${process.platform}`)
    }
    await installer();
    core.info(await io.which(ccacheVariant + ".exe"));
    ccachePath = await io.which(ccacheVariant, true);
    core.endGroup();
  }

  core.startGroup("Restore cache");
  await restore(ccacheVariant);
  core.endGroup();

  core.startGroup(`Configure ${ccacheVariant}, ${process.platform}`);
  await configure(ccacheVariant, process.platform);
  await execShell(`${ccacheVariant} -z`);
  core.endGroup();
}

async function run() : Promise<void> {
  try {
    await runInner();
  } catch (error) {
    core.setFailed(`Restoring cache failed: ${error}`);
  }
}

run();

export default run;
