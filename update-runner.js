'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

var configDir = process.argv[2];
var repositoryDir = process.argv[3];
var version = process.argv[4];
var build = process.argv[5];
var displayVersion = process.argv[6];
var stateFile = path.join(configDir, 'update-status.json');
var installedBuildSaved = false;
var previousInstalledBuild;
var hadPreviousInstalledBuild = false;
var buildInfoPath = path.join(configDir, 'build-info.json');
var previousBuildInfo;
var hadPreviousBuildInfo = false;

function saveState(status, details) {
    fs.writeFileSync(stateFile, JSON.stringify({
        status: status,
        details: details || '',
        updatedAt: new Date().toISOString()
    }, null, 2));
}

function removeRepository() {
    if (!repositoryDir || repositoryDir.indexOf(path.join(require('os').tmpdir(), 'yam-update-')) !== 0) {
        return;
    }

    try {
        removeTree(repositoryDir);
    } catch (err) {
        // Temporary source cleanup is best-effort; the update result remains authoritative.
    }
}

function removeTree(target) {
    if (!fs.existsSync(target)) {
        return;
    }
    var stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
        fs.readdirSync(target).forEach(function(name) {
            removeTree(path.join(target, name));
        });
        fs.rmdirSync(target);
    } else {
        fs.unlinkSync(target);
    }
}

function writeInstalledBuild(value) {
    var configPath = path.join(configDir, 'config.json');
    var config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!installedBuildSaved) {
        hadPreviousInstalledBuild = config.installedBuild !== undefined;
        previousInstalledBuild = hadPreviousInstalledBuild ? JSON.parse(JSON.stringify(config.installedBuild)) : undefined;
    }
    if (value === null) {
        delete config.installedBuild;
    } else if (value && typeof value === 'object') {
        config.installedBuild = value;
    } else if (config.installedBuild && typeof config.installedBuild === 'object') {
        config.installedBuild.value = value;
    } else {
        config.installedBuild = {type: 'string', value: value};
    }

    var temporaryConfigPath = configPath + '.tmp';
    fs.writeFileSync(temporaryConfigPath, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(temporaryConfigPath, configPath);
}

function saveInstalledBuild() {
    if (!installedBuildSaved) {
        hadPreviousBuildInfo = fs.existsSync(buildInfoPath);
        previousBuildInfo = hadPreviousBuildInfo ? fs.readFileSync(buildInfoPath, 'utf8') : undefined;
        installedBuildSaved = true;
    }
    writeInstalledBuild(build);
    fs.writeFileSync(buildInfoPath, JSON.stringify({version: version, build: build}, null, 2));
}

function restorePreviousInstalledBuild() {
    if (!installedBuildSaved) return;
    try {
        writeInstalledBuild(hadPreviousInstalledBuild ? previousInstalledBuild : null);
        if (hadPreviousBuildInfo) {
            fs.writeFileSync(buildInfoPath, previousBuildInfo);
        } else if (fs.existsSync(buildInfoPath)) {
            fs.unlinkSync(buildInfoPath);
        }
    } catch (err) {
        // Keep the installation error authoritative; rollback is best-effort.
    }
    installedBuildSaved = false;
}

function restartVolumio() {
    setTimeout(function() {
        saveState('restarting', displayVersion);
        setTimeout(function() {
        childProcess.execFile('/usr/bin/sudo', ['/bin/systemctl', 'restart', 'volumio'], {
            cwd: '/',
            timeout: 60000
        }, function(err, stdout, stderr) {
            if (err) {
                saveState('restart_failed', String(stderr || err.message || err).slice(-500));
                removeRepository();
                process.exitCode = 1;
                return;
            }
            saveState('restart_completed', displayVersion);
            removeRepository();
        });
        }, 2500);
    }, 3500);
}

if (!configDir || !repositoryDir || !version || !build) {
    throw new Error('Missing YaM update runner arguments');
}

var completed = false;
var updateOutput = '';
try {
    // Write the target commit before the plugin update starts, so the new
    // service can read it as soon as it comes back up.
    saveInstalledBuild();
} catch (configError) {
    restorePreviousInstalledBuild();
    saveState('failed', 'Unable to save installed build id: ' + (configError.message || configError));
    removeRepository();
    throw configError;
}

var updateProcess = childProcess.spawn('volumio', ['plugin', 'update'], {
    cwd: repositoryDir,
    env: Object.assign({}, process.env, {HOME: '/home/volumio'}),
    stdio: ['ignore', 'pipe', 'pipe']
});

function finishInstallation() {
    if (completed) {
        return;
    }
    completed = true;
    clearTimeout(updateTimeout);
    try {
        saveInstalledBuild();
        // saveInstalledBuild() already persisted the selected GitHub version
        // and commit before installation started.
        saveState('restart_requested', displayVersion);
    } catch (writeErr) {
        restorePreviousInstalledBuild();
        saveState('failed', String(writeErr.message || writeErr).slice(-500));
        removeRepository();
        process.exitCode = 1;
        return;
    }
    restartVolumio();
    setTimeout(function() {
        if (updateProcess.exitCode === null && updateProcess.signalCode === null) {
            updateProcess.kill('SIGTERM');
        }
    }, 750);
}

function failInstallation(message) {
    if (completed) {
        return;
    }
    completed = true;
    clearTimeout(updateTimeout);
    restorePreviousInstalledBuild();
    saveState('failed', String(message || 'Plugin update failed').slice(-500));
    removeRepository();
    process.exitCode = 1;
}

function captureOutput(chunk) {
    updateOutput = (updateOutput + chunk.toString()).slice(-12000);
}

updateProcess.stdout.on('data', captureOutput);
updateProcess.stderr.on('data', captureOutput);
updateProcess.on('error', failInstallation);
updateProcess.on('close', function(code, signal) {
    if (completed) {
        return;
    }
    if (code === 0) {
        finishInstallation();
    } else {
        var failure = 'volumio plugin update exited with code ' + code + (signal ? ' (' + signal + ')' : '');
        if (updateOutput) {
            failure += ': ' + updateOutput.slice(-1500);
        }
        failInstallation(failure);
    }
});

var updateTimeout = setTimeout(function() {
    if (updateProcess.exitCode === null && updateProcess.signalCode === null) {
        updateProcess.kill('SIGTERM');
    }
    failInstallation('Timed out while installing the YaM plugin. ' + updateOutput);
}, 15 * 60 * 1000);
