'use strict';

var libQ = require('kew');
var fs=require('fs-extra');
var config = new (require('v-conf'))();
var exec = require('child_process').exec;
var execFile = require('child_process').execFile;
var execSync = require('child_process').execSync;
var os = require('os');
var path = require('path');
var clientApi = require('yandex-music-client').YandexMusicClient;
var querystring = require('querystring');
var axios = require('axios');
var NodeCache = require('node-cache');
var getToken = require('./token.js');
var getTrackUrl = require('./track.js');
var playlist = require('./playlist.js');
var proxy = require('./proxy.js');
var util = require('util');

module.exports = yandexMusic;

function yandexMusic(context) {
    var self = this;

    self.context = context;
    self.commandRouter = self.context.coreCommand;
    self.logger = self.context.logger;
    self.configManager = self.context.configManager;

    // We use a caching manager to speed up the presentation of root page
    self.browseCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

    self.titles = {};
    self.playlists = {};
    self.current_track = false;
    self.positionAtPrefetch = -1;

    self.proxy = new proxy(self.logger);
}

yandexMusic.prototype.onVolumioStart = function()
{
    var self = this;
    var configFile = self.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
    self.configFile = configFile;
    self.updateStateFile = path.join(path.dirname(configFile), 'update-status.json');
    self.config = new (require('v-conf'))();
    self.config.loadFile(configFile);
    self.loadI18n();

    self.titles['user:onyourwave'] = self.getI18n('MY_WAVE');

    return libQ.resolve();
}

yandexMusic.prototype.onStart = function() {
    var self = this;

    var updateState = self.getUpdateState();
    if (['restart_requested', 'restarting'].indexOf(updateState.status) !== -1) {
        self.writeUpdateState('restart_completed', updateState.details);
        self.commandRouter.pushToastMessage('success', self.getI18n('YAM_ACCOUNT'), self.getI18n('UPDATE_RESTART_COMPLETED') + (updateState.details ? ': ' + updateState.details : ''));
    }

    self.addToBrowseSources();
    self.mpdPlugin = self.commandRouter.pluginManager.getPlugin('music_service', 'mpd');

    self.commandRouter.addCallback('volumioPushState', self.onPushState.bind(self));

    self.initClient();

    self.hq = !!self.config.get('hq');
    if (self.hq) {
        return self.proxy.start().then(function () {
            return libQ.resolve();
        }).fail(function (err) {
            self.logger.error('Unable to start YaM proxy', err);
            return libQ.resolve();
        });
    }

    return libQ.resolve();
};

yandexMusic.prototype.onStop = function() {
    var self = this;

    self.removeFromBrowseSources();

    self.proxy.stop();

    return libQ.resolve();
};

yandexMusic.prototype.loadI18n = function () {
    var self = this;
    try {
        var language_code = this.commandRouter.sharedVars.get('language_code');
        self.i18n=fs.readJsonSync(__dirname+'/i18n/strings_'+language_code+".json");
    } catch(e) {
        self.i18n=fs.readJsonSync(__dirname+'/i18n/strings_en.json');
    }
    self.i18nDefaults=fs.readJsonSync(__dirname+'/i18n/strings_en.json');
};

yandexMusic.prototype.getI18n = function (key) {
    var self = this;
    if (key.indexOf('.') > 0) {
        var mainKey = key.split('.')[0];
        var secKey = key.split('.')[1];
        if (self.i18n[mainKey][secKey] !== undefined) {
            return self.i18n[mainKey][secKey];
        } else {
            return self.i18nDefaults[mainKey][secKey];
        }
    } else {
        if (self.i18n[key] !== undefined) {
            return self.i18n[key];
        } else {
            return self.i18nDefaults[key];
        }
    }
};

yandexMusic.prototype.initClient = function() {
    var self = this;

    self.uid = undefined;
    self.playlists = {};
    self.browseCache.del('root');

    self.client = new clientApi({
        BASE: 'https://api.music.yandex.net:443',
        HEADERS: {
            'Authorization': 'OAuth ' + self.config.get('token', 'none'),
            'Accept-Language': self.commandRouter.sharedVars.get('language_code'),
            'X-Yandex-Music-Client': 'YandexMusicDesktopAppWindows/5.25.1',
        }
    });

    self.checkUid();
};

yandexMusic.prototype.checkUid = function() {
    var defer = libQ.defer();
    var self = this;

    if (self.uid === undefined) {
        self.client.account.getAccountStatus().then(function (resp) {
            self.uid = resp.result.account.uid;
            defer.resolve(self.uid);
        }).catch(function (err) {
            if (err && err.status == 401) {
                // Invalid token
                self.uid = false;
                defer.resolve(self.uid);
            } else {
                // Network problem
                defer.reject(new Error());
            }
        });
    } else {
        defer.resolve(self.uid);
    }

    return defer.promise;
};

// Configuration Methods -----------------------------------------------------------------------------

yandexMusic.prototype.getUIConfig = function() {
    var defer = libQ.defer();
    var self = this;

    var lang_code = this.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname+'/i18n/strings_'+lang_code+'.json',
        __dirname+'/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then(function(uiconf)
        {
            var token = self.config.get('token', 'none');
            if (!token || token == 'none') {
                uiconf.sections[0].content[0].value.value = 1;
                uiconf.sections[0].content[1].value = self.config.get('password', '');
            } else {
                uiconf.sections[0].content[0].value.value = 2;
                uiconf.sections[0].content[0].hidden = true;
                uiconf.sections[0].content[1].hidden = true;
                uiconf.sections[0].content[2].hidden = true;
                uiconf.sections[0].content[3].attributes = [{"readonly": true}];
                uiconf.sections[0].content[3].value = token;
                uiconf.sections[0].saveButton.label = self.getI18n('LOGOUT');
                uiconf.sections[0].onSave.method = 'accountLogout';
            }
            uiconf.sections[1].content[0].value = !!self.config.get('hq');

            var currentVersion = self.getInstalledVersion();
            var currentBuild = self.getInstalledBuild();
            var githubVersion = self.config.get('githubVersion', '');
            var githubBuild = self.config.get('githubBuild', '');
            self.setUpdateFieldValue(uiconf, 'installed_version', self.formatVersionBuild(currentVersion, currentBuild));
            self.setUpdateFieldValue(uiconf, 'github_version', githubVersion ? self.formatVersionBuild(githubVersion, githubBuild) : self.getI18n('UPDATE_VERSION_UNKNOWN'));

            var updateStatus = self.config.get('lastUpdateStatus', '');
            var savedUpdateState = self.getUpdateState();
            updateStatus = savedUpdateState.status || updateStatus;
            var updateDetails = savedUpdateState.details || self.config.get('lastUpdateDetails', '');
            var inProgress = ['checking', 'downloading', 'installing', 'restart_requested', 'restarting'].indexOf(updateStatus) !== -1;
            var failed = ['failed', 'restart_failed', 'check_failed'].indexOf(updateStatus) !== -1;
            var statusText;
            if (inProgress || failed) {
                statusText = self.getI18n('UPDATE_STATUS_' + updateStatus);
                if (updateDetails) {
                    statusText += ': ' + updateDetails;
                }
            } else if (githubVersion && githubBuild) {
                var isLatest = String(currentVersion) === String(githubVersion) && String(currentBuild) === String(githubBuild);
                statusText = self.getI18n(isLatest ? 'UPDATE_STATUS_latest' : 'UPDATE_STATUS_available');
            } else if (updateStatus === 'restart_completed') {
                statusText = self.getI18n('UPDATE_STATUS_restart_completed');
            } else {
                statusText = self.getI18n('UPDATE_STATUS_check_required');
            }
            self.setUpdateFieldValue(uiconf, 'update_status', statusText);
            defer.resolve(uiconf);
        })
        .fail(function()
        {
            defer.reject(new Error());
        });

    return defer.promise;
};

yandexMusic.prototype.setUpdateFieldValue = function(uiconf, fieldId, value) {
    var section = uiconf.sections.filter(function(item) {
        return item.id === 'section_update';
    })[0];
    if (!section) {
        return;
    }
    var field = section.content.filter(function(item) {
        return item.id === fieldId;
    })[0];
    if (field) {
        field.value = value;
    }
};

yandexMusic.prototype.getUpdateState = function() {
    try {
        if (this.updateStateFile && fs.existsSync(this.updateStateFile)) {
            return fs.readJsonSync(this.updateStateFile);
        }
    } catch (err) {
        this.logger.warn('Unable to read YaM update state', err.message || err);
    }
    return {
        status: this.config.get('lastUpdateStatus', ''),
        details: this.config.get('lastUpdateDetails', '')
    };
};

yandexMusic.prototype.writeUpdateState = function(status, details) {
    this.config.set('lastUpdateStatus', status);
    this.config.set('lastUpdateDetails', details || '');
    try {
        if (this.updateStateFile) {
            fs.writeJsonSync(this.updateStateFile, {
                status: status,
                details: details || '',
                updatedAt: new Date().toISOString()
            }, {spaces: 2});
        }
    } catch (err) {
        this.logger.warn('Unable to save YaM update state', err.message || err);
    }
};

yandexMusic.prototype.formatVersionBuild = function(version, build) {
    return String(version) + ' (' + this.getI18n('BUILD_NUMBER') + ' ' + (build || this.getI18n('BUILD_UNKNOWN')) + ')';
};

yandexMusic.prototype.getInstalledVersion = function() {
    try {
        return fs.readJsonSync(path.join(__dirname, 'package.json')).version || this.getI18n('UPDATE_VERSION_UNKNOWN');
    } catch (err) {
        this.logger.warn('Unable to read installed YaM version', err.message || err);
        return this.getI18n('UPDATE_VERSION_UNKNOWN');
    }
};

yandexMusic.prototype.getInstalledBuild = function() {
    try {
        var installedPackage = fs.readJsonSync(path.join(__dirname, 'package.json'));
        if (installedPackage.build !== undefined && installedPackage.build !== null && installedPackage.build !== '') {
            return String(installedPackage.build);
        }
    } catch (err) {
        this.logger.warn('Unable to read installed YaM build number', err.message || err);
    }

    try {
        if (this.configFile) {
            var markerPath = path.join(path.dirname(this.configFile), 'build-info.json');
            var marker = fs.readJsonSync(markerPath);
            if (marker.version === this.getInstalledVersion() && marker.build) {
                return String(marker.build);
            }
        }
    } catch (err) {
        // The marker is optional for plugins installed before build tracking was added.
    }

    try {
        var gitBuild = execSync('git rev-parse --short=12 HEAD', {
            cwd: __dirname,
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore']
        }).toString().trim();
        if (gitBuild) {
            return gitBuild;
        }
    } catch (err) {
        // Installed plugin packages often omit .git.
    }

    var storedBuild = this.config.get('installedBuild', '');
    if (storedBuild) {
        return String(storedBuild);
    }

    return '';
};

yandexMusic.prototype.checkGithubVersion = function() {
    var self = this;
    self.writeUpdateState('checking', '');
    self.commandRouter.pushToastMessage('info', self.getI18n('YAM_ACCOUNT'), self.getI18n('VERSION_CHECK_STARTED'));
    self.getUIConfig().then(function(uiconf) {
        self.commandRouter.broadcastMessage('pushUiConfig', uiconf);
    });

    return axios.get('https://raw.githubusercontent.com/GorINIch73/YaM/main/package.json', { timeout: 15000 })
        .then(function(resp) {
            var packageInfo = resp.data || {};
            if (!packageInfo.version) {
                throw new Error('GitHub package.json does not contain a version');
            }
            if (packageInfo.build !== undefined && packageInfo.build !== null && packageInfo.build !== '') {
                return {version: String(packageInfo.version), build: String(packageInfo.build)};
            }
            return axios.get('https://api.github.com/repos/GorINIch73/YaM/commits/main', {
                timeout: 15000,
                headers: {'Accept': 'application/vnd.github+json'}
            }).then(function(commitResp) {
                var sha = commitResp.data && commitResp.data.sha;
                if (!sha) {
                    throw new Error('GitHub did not return the latest commit id');
                }
                return {version: String(packageInfo.version), build: String(sha).substring(0, 12)};
            });
        })
        .then(function(remote) {
            var version = remote.version;
            var githubBuild = remote.build;
            self.config.set('githubVersion', String(version));
            self.config.set('githubBuild', githubBuild);
            var installedBuild = self.getInstalledBuild();
            var isLatest = String(self.getInstalledVersion()) === String(version) && String(installedBuild) === githubBuild;
            self.writeUpdateState(isLatest ? 'latest' : 'available', '');
            self.commandRouter.pushToastMessage('success', self.getI18n('YAM_ACCOUNT'), self.getI18n(isLatest ? 'UPDATE_STATUS_latest' : 'UPDATE_STATUS_available') + ': ' + self.formatVersionBuild(version, githubBuild));
            return self.getUIConfig().then(function(uiconf) {
                self.commandRouter.broadcastMessage('pushUiConfig', uiconf);
            });
        })
        .catch(function(err) {
            self.writeUpdateState('check_failed', String(err.message || err).slice(-300));
            self.logger.warn('Unable to check YaM version on GitHub', err.message || err);
            self.commandRouter.pushToastMessage('error', self.getI18n('YAM_ACCOUNT'), self.getI18n('VERSION_CHECK_FAILED'));
            self.getUIConfig().then(function(uiconf) {
                self.commandRouter.broadcastMessage('pushUiConfig', uiconf);
            });
            throw err;
        });
};

yandexMusic.prototype.getConfigurationFiles = function() {
    return ['config.json'];
}

yandexMusic.prototype.setUIConfig = function(data) {
};

yandexMusic.prototype.getConf = function(varName) {
};

yandexMusic.prototype.setConf = function(varName, varValue) {
};

yandexMusic.prototype.accountLogin = function(data) {
    var self = this;
    var defer = libQ.defer();

    getToken(data, self.logger).then(function (token) {
        self.config.set('token', token);
        self.commandRouter.pushToastMessage('success', self.getI18n('YAM_ACCOUNT'), self.getI18n('LOGIN_SUCCESSFUL'));
        self.initClient();

        var config = self.getUIConfig();
        config.then(function(conf) {
            self.commandRouter.broadcastMessage('pushUiConfig', conf);
        });

        defer.resolve();
    }).fail(function (err) {
        var err_msg;
        if (err instanceof Error && err.message == 'no_username') {
            err_msg = self.getI18n('LOGIN_FAILED_NO_USERNAME');
        } else if (err instanceof Error && err.message == 'account_not_found') {
            err_msg = self.getI18n('LOGIN_FAILED_INVALID_ACCOUNT');
        } else if (err instanceof Error && err.message == 'redirect_url') {
            err_msg = self.getI18n('LOGIN_FAILED_REDIRECT_NOT_SUPPORTED');
        } else if (err instanceof Error && err.message == 'password_not_matched') {
            err_msg = self.getI18n('LOGIN_FAILED_INVALID_PASSWORD');
        } else if (err instanceof Error && err.message == 'invalid_token') {
            err_msg = self.getI18n('LOGIN_FAILED_INVALID_TOKEN');
        } else {
            err_msg = self.getI18n('LOGIN_FAILED');
        }
        self.commandRouter.pushToastMessage('error', self.getI18n('YAM_ACCOUNT'), err_msg);
        self.logger.error('Unable to login, getToken failed: ', err);
        defer.resolve();
    });

    return defer.promise;
};

yandexMusic.prototype.accountLogout = function(data) {
    var self = this;

    self.config.set('token', 'none');
    self.commandRouter.pushToastMessage('success', self.getI18n('YAM_ACCOUNT'), self.getI18n('LOGOUT_SUCCESSFUL'));
    self.initClient();

    var config = self.getUIConfig();
    config.then(function(conf) {
        self.commandRouter.broadcastMessage('pushUiConfig', conf);
    });

    return libQ.resolve();
};

yandexMusic.prototype.configPlaybackSave = function(data) {
    var self = this;

    self.config.set('hq', data.hq);
    self.commandRouter.pushToastMessage('success', self.getI18n('PLAYBACK'), self.getI18n('PLAYBACK_UPDATED'));

    self.hq = !!self.config.get('hq');
    if (self.hq) {
        return self.proxy.start().then(function () {
            return libQ.resolve();
        }).fail(function (err) {
            self.logger.error('Unable to start YaM proxy', err);
            return libQ.reject(err);
        });
    } else {
        self.proxy.stop();
    }

    return libQ.resolve();
};

yandexMusic.prototype.updateFromGithub = function() {
    var self = this;
    var inProgressStatuses = ['downloading', 'installing', 'restart_requested', 'restarting'];

    if (self.updating || inProgressStatuses.indexOf(self.getUpdateState().status) !== -1) {
        return libQ.reject(new Error('YaM update is already running'));
    }
    self.updating = true;

    self.writeUpdateState('downloading', '');
    self.commandRouter.pushToastMessage('info', self.getI18n('YAM_ACCOUNT'), self.getI18n('UPDATE_STARTED'));
    self.getUIConfig().then(function(uiconf) {
        self.commandRouter.broadcastMessage('pushUiConfig', uiconf);
    }).fail(function(err) {
        self.logger.warn('Unable to show YaM update progress', err);
    });

    return new Promise(function(resolve, reject) {
        fs.mkdtemp(path.join(os.tmpdir(), 'yam-update-'), function(tempDirError, tempDir) {
            if (tempDirError) {
                reject(tempDirError);
                return;
            }

            execFile('git', [
                'clone', '--depth', '1', '--branch', 'main',
                'https://github.com/GorINIch73/YaM.git', tempDir
            ], { timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 }, function(cloneError, stdout, stderr) {
                if (cloneError) {
                    cloneError.details = stderr || stdout || cloneError.details;
                    fs.remove(tempDir, function() {});
                    reject(cloneError);
                    return;
                }

                var remoteVersion;
                var remoteBuild;
                var displayVersion;
                try {
                    var remotePackage = fs.readJsonSync(path.join(tempDir, 'package.json'));
                    remoteVersion = remotePackage.version;
                    remoteBuild = (remotePackage.build !== undefined && remotePackage.build !== null && remotePackage.build !== '') ? String(remotePackage.build) : execSync('git rev-parse --short=12 HEAD', {
                        cwd: tempDir,
                        timeout: 5000,
                        stdio: ['ignore', 'pipe', 'ignore']
                    }).toString().trim();
                    displayVersion = self.formatVersionBuild(remoteVersion, remoteBuild);
                } catch (versionError) {
                    fs.remove(tempDir, function() {});
                    reject(versionError);
                    return;
                }

                self.writeUpdateState('installing', displayVersion);
                self.getUIConfig().then(function(uiconf) {
                    self.commandRouter.broadcastMessage('pushUiConfig', uiconf);
                }).fail(function(err) {
                    self.logger.warn('Unable to show YaM install progress', err);
                });

                var runnerPath = path.join(tempDir, 'update-runner.js');
                if (!fs.existsSync(runnerPath) && fs.existsSync(path.join(__dirname, 'update-runner.js'))) {
                    fs.copyFileSync(path.join(__dirname, 'update-runner.js'), runnerPath);
                }
                if (!fs.existsSync(runnerPath)) {
                    var runnerError = new Error('Update runner is missing from the GitHub checkout');
                    fs.remove(tempDir, function() {});
                    reject(runnerError);
                    return;
                }

                var configDir = path.dirname(self.configFile);
                var unitName = 'yam-plugin-update-' + Date.now();
                execFile('/usr/bin/sudo', [
                    '/usr/bin/systemd-run',
                    '--unit=' + unitName,
                    '--collect',
                    '--uid=volumio',
                    '--working-directory=' + tempDir,
                    '--setenv=HOME=/home/volumio',
                    '--setenv=PATH=' + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin'),
                    process.execPath,
                    runnerPath,
                    configDir,
                    tempDir,
                    String(remoteVersion),
                    String(remoteBuild),
                    displayVersion
                ], {timeout: 30000, maxBuffer: 1024 * 1024}, function(scheduleError, stdout, stderr) {
                    self.updating = false;
                    if (scheduleError) {
                        scheduleError.details = stderr || stdout || scheduleError.details;
                        fs.remove(tempDir, function() {});
                        reject(scheduleError);
                        return;
                    }

                    self.logger.info('YaM update job scheduled as ' + unitName + ': ' + (stdout || '').trim());
                    self.commandRouter.pushToastMessage('info', self.getI18n('YAM_ACCOUNT'), self.getI18n('UPDATE_INSTALLING'));
                    self.monitorUpdateJob();
                    resolve();
                });
            });
        });
    }).catch(function(err) {
        self.updating = false;
        self.writeUpdateState('failed', String(err.details || err.stderr || err.message || err).slice(-500));
        self.logger.error('Unable to prepare YaM update from GitHub', err);
        self.commandRouter.pushToastMessage('error', self.getI18n('YAM_ACCOUNT'), self.getI18n('UPDATE_FAILED') + ': ' + String(err.details || err.stderr || err.message || err).slice(-180));
        throw err;
    });
};

yandexMusic.prototype.monitorUpdateJob = function() {
    var self = this;
    var installNotified = false;
    var restartNotified = false;
    var timer = setInterval(function() {
        var state = self.getUpdateState();
        if (state.status === 'restart_requested' && !installNotified) {
            installNotified = true;
            self.commandRouter.pushToastMessage('success', self.getI18n('YAM_ACCOUNT'), self.getI18n('UPDATE_SUCCESS') + (state.details ? ' ' + state.details : ''));
        }
        if (state.status === 'restarting' && !restartNotified) {
            restartNotified = true;
            self.commandRouter.pushToastMessage('info', self.getI18n('YAM_ACCOUNT'), self.getI18n('UPDATE_RESTARTING'));
        }
        if (['failed', 'restart_failed'].indexOf(state.status) !== -1) {
            self.commandRouter.pushToastMessage('error', self.getI18n('YAM_ACCOUNT'), self.getI18n(state.status === 'failed' ? 'UPDATE_FAILED' : 'UPDATE_RESTART_FAILED') + (state.details ? ': ' + state.details : ''));
            clearInterval(timer);
        } else if (state.status === 'restart_completed') {
            clearInterval(timer);
        }
    }, 1000);
    if (timer.unref) {
        timer.unref();
    }
};

// Playback Controls ---------------------------------------------------------------------------------------

yandexMusic.prototype.addToBrowseSources = function () {
    var data = {
        name: this.getI18n('YM'),
        uri: 'yam',
        plugin_type: 'music_service',
        plugin_name: 'yam',
        albumart: '/albumart?sourceicon=music_service/yam/yam.png'
    };
    this.commandRouter.volumioAddToBrowseSources(data);
};

yandexMusic.prototype.removeFromBrowseSources = function () {

    this.commandRouter.volumioRemoveToBrowseSources(this.getI18n('YM'));
};

// Resolve the Yandex track id from a Volumio item. Track ids in YaM URIs may
// include an album id and a playlist suffix: trackId:albumId@playlistId.
yandexMusic.prototype.getTrackIdFromFavourite = function (data) {
    var uri = (data && typeof data.uri == 'string') ? data.uri : '';
    var match = uri.match(/^yam\/track\/([^/?#]+)/);
    if (match) {
        return match[1].split('@')[0];
    }

    // Volumio can pass MPD's resolved audio URI for the currently playing
    // item. Keep the original YaM id captured before resolving that URL.
    if (this.current_track && this.current_track.track_id) {
        return this.current_track.track_id.split('@')[0];
    }

    return null;
};

yandexMusic.prototype.setTrackFavourite = function (data, liked) {
    var self = this;
    var trackId = self.getTrackIdFromFavourite(data);

    if (!trackId) {
        return libQ.reject(new Error('Unable to determine Yandex Music track id'));
    }

    return self.checkUid().then(function (uid) {
        if (!uid) {
            throw new Error('Yandex Music account is not authorized');
        }

        var action = liked ? 'add-multiple' : 'remove';
        var headers = Object.assign({}, self.client.request.config.HEADERS, {
            'Content-Type': 'application/x-www-form-urlencoded'
        });
        return axios.post(
            'https://api.music.yandex.net/users/' + encodeURIComponent(uid) + '/likes/tracks/' + action,
            querystring.stringify({'track-ids': trackId}),
            { headers: headers, timeout: 15000 }
        ).then(function(resp) {
            if (resp.data && resp.data.error) {
                throw new Error(resp.data.error.message || 'Yandex Music rejected the like');
            }
            return resp.data;
        });
    }).then(function (result) {
        self.logger.info((liked ? 'Added track to' : 'Removed track from') + ' Yandex Music likes: ' + trackId);
        self.commandRouter.pushToastMessage('success', self.getI18n('YAM_ACCOUNT'), self.getI18n(liked ? 'LIKE_SENT' : 'LIKE_REMOVED'));
        return result;
    }).catch(function(err) {
        self.logger.error('Unable to sync YaM like with Yandex Music', err);
        self.commandRouter.pushToastMessage('error', self.getI18n('YAM_ACCOUNT'), self.getI18n('LIKE_FAILED'));
        throw err;
    });
};

yandexMusic.prototype.addToFavourites = function (data) {
    return this.setTrackFavourite(data, true);
};

yandexMusic.prototype.removeFromFavourites = function (data) {
    return this.setTrackFavourite(data, false);
};

yandexMusic.prototype.handleBrowseUri = function (curUri) {
    var self = this;

    var response;
    var uriParts = curUri.split('/');

    if (curUri.startsWith('yam')) {
        if (curUri == 'yam') {
            response = self.browseRoot();
        } else if (curUri == 'yam/myplaylists') {
            response = self.browseMyPlaylists();
        } else if (curUri.startsWith('yam/radio/')) {
            response = self.browseRadio(uriParts.pop());
        } else if (curUri.startsWith('yam/playlist/')) {
            response = self.browsePlaylist(uriParts.pop());
        } else if (curUri.startsWith('yam/artist/')) {
            response = self.browseArtist(uriParts.pop());
        } else if (curUri.startsWith('yam/album/')) {
            response = self.browseAlbum(uriParts.pop());
        } else {
            response = libQ.reject();
        }
    } else {
        response = libQ.reject();
    }

    return response;
};

yandexMusic.prototype.browseRoot = function () {
    var self = this;
    var defer = libQ.defer();

    self.checkUid().then(function (uid) {
        if (!self.uid) {
            var response = {
                navigation: {
                    lists: [
                        {
                            "availableListViews": ["list"],
                            "type": "title",
                            "title": self.getI18n('USERNAME_TIP'),
                            "items": []
                        },
                    ]
                }
            };
            defer.resolve(response);
        } else {
            self.browseCache.get('root', function(err, value){
                if (!err) {
                    // Root has not been cached yet
                    if (value == undefined) {
                        self.listRoot().then( (data) => {
                            // Set root cache
                            self.browseCache.set('root', data);
                            defer.resolve(data);
                        });
                    } else {
                        // Cached Root
                        defer.resolve(value);
                    }
                } else {
                    defer.reject(new Error(err));
                }
            });
        }
    }).fail(function (err) {
        var response = {
            navigation: {
                lists: [
                    {
                        "availableListViews": ["list"],
                        "type": "title",
                        "title": self.getI18n('NETWORK_ERROR'),
                        "items": []
                    },
                ]
            }
        };
        defer.resolve(response);
    });

    return defer.promise;
};

yandexMusic.prototype.listRoot = function () {
    var self = this;
    var defer = libQ.defer();

    var response = {
        navigation: {
            lists: [
                {
                    "availableListViews": [
                        "grid","list"
                    ],
                    "type": "title",
                    "title": self.getI18n('MY_WAVE'),
                    "items": [
                        {
                            service: 'yam',
                            type: 'playlist',
                            title: self.getI18n('MY_PLAYLISTS'),
                            artist: '',
                            album: '',
                            albumart: '/albumart?sourceicon=music_service/yam/icons/playlist.png',
                            uri: 'yam/myplaylists'
                        },
                    ]
                },
                {
                    "availableListViews": [
                        "grid","list"
                    ],
                    "type": "title",
                    "title": self.getI18n('MY_SELECTED'),
                    "items": [
                    ]
                },
                {
                    "availableListViews": [
                        "grid","list"
                    ],
                    "type": "title",
                    "title": self.getI18n('MY_NEW_RELEASES'),
                    "items": [
                    ]
                },
                {
                    "availableListViews": [
                        "grid","list"
                    ],
                    "type": "title",
                    "title": self.getI18n('MY_POP_PLAYLISTS'),
                    "items": [
                    ]
                },
                {
                    "availableListViews": [
                        "grid","list"
                    ],
                    "type": "title",
                    "title": self.getI18n('MY_PLAY_CONTEXTS'),
                    "items": [
                    ]
                },
            ]
        }
    };

    self.client.landing.getLandingBlocks('personal-playlists,new-releases,new-playlists,play-contexts').then(function (resp) {
        var p = new playlist(self.client, self.uid);
        var block;
        // Selected for You
        block = resp.result.blocks.find(function (x) { return x.type == 'personal-playlists'; });
        if (block) {
            var blocks = block.entities.map(function (x) { return p.landingToPlaylist(x.data.data); });
            for (var i = 0; i < blocks.length; ++i) {
                self.titles[blocks[i].id] = blocks[i].title;
                response.navigation.lists[1].items.push(blocks[i]);
            }
        }
        // New releases
        block = resp.result.blocks.find(function (x) { return x.type == 'new-releases'; });
        if (block) {
            var blocks = block.entities.map(function (x) { return p.albumToAlbum(x.data); });
            for (var i = 0; i < blocks.length; ++i) {
                response.navigation.lists[2].items.push(blocks[i]);
            }
        }
        // Popular playlists
        block = resp.result.blocks.find(function (x) { return x.type == 'new-playlists'; });
        if (block) {
            var blocks = block.entities.map(function (x) { return p.landingToPlaylist(x.data); });
            for (var i = 0; i < blocks.length; ++i) {
                self.titles[blocks[i].id] = blocks[i].title;
                response.navigation.lists[3].items.push(blocks[i]);
            }
        }
        // Recently played
        block = resp.result.blocks.find(function (x) { return x.type == 'play-contexts'; });
        if (block) {
            var albums = block.entities.filter(function (x) { return x.data.context == 'album'; });
            var blocks = albums.map(function (x) { return p.albumToAlbum(x.data.payload); });
            for (var i = 0; i < blocks.length; ++i) {
                response.navigation.lists[4].items.push(blocks[i]);
            }
        }
        // Radio dashboard
        self.client.rotor.getRotorStationsDashboard().then(function (resp) {
            var blocks = resp.result.stations.map(function (x) { return p.stationToRadio(x.station); });
            for (var i = 0; i < blocks.length; ++i) {
                self.titles[blocks[i].id] = blocks[i].title;
                response.navigation.lists[0].items.push(blocks[i]);
            }
            defer.resolve(response);
        }).catch(function (err) {
            defer.resolve(response);
        });
    }).catch(function (err) {
        defer.reject(new Error());
    });

    return defer.promise;
};

yandexMusic.prototype.browseMyPlaylists = function () {
    var self = this;
    var defer = libQ.defer();

    var likesId = self.uid + ':3';
    var response = {
        navigation: {
            lists: [
                {
                    "availableListViews": ["grid", "list"],
                    "type": "title",
                    "title": self.getI18n('MY_PLAYLISTS'),
                    "items": [{
                        id: likesId,
                        service: 'yam',
                        type: 'playlist',
                        name: self.getI18n('MY_LIKES'),
                        title: self.getI18n('MY_LIKES'),
                        albumart: 'https://avatars.yandex.net/get-music-user-playlist/11418140/favorit-playlist-cover.bb48fdb9b9f4/200x200',
                        uri: 'yam/playlist/' + likesId
                    }]
                }
            ]
        }
    };

    self.titles[likesId] = self.getI18n('MY_LIKES');

    self.client.user.getPlayLists(self.uid).then(function (resp) {

        var p = new playlist(self.client, self.uid);
        var blocks = resp.result.map(function (x) { return p.landingToPlaylist(x); });
        for (var i = 0; i < blocks.length; ++i) {
            self.titles[blocks[i].id] = blocks[i].title;
            response.navigation.lists[0].items.push(blocks[i]);
        }

        defer.resolve(response);
    }).catch(function (err) {
        self.logger.error('Unable to load YaM playlists', err);
        // Keep the likes entry visible even if the separate playlists call
        // fails; its tracks are loaded independently from the likes API.
        defer.resolve(response);
    });

    return defer.promise;
};

yandexMusic.prototype.browseRadio = function (playlist_id) {
    var self = this;
    var defer = libQ.defer();

    // Always create new radio
    self.playlists[playlist_id] = new playlist(self.client, self.uid, playlist_id, 'radio', self.logger);
    self.playlists[playlist_id].title = self.titles[playlist_id];

    self.playlists[playlist_id].fetch().then(function (tracks) {
        var response = {
            navigation: {
                lists: [
                    {
                        "availableListViews": ["list"],
                        "type": "playlist",
                        "title": self.playlists[playlist_id].title,
                        "items": tracks
                    }
                ]
            }
        };
        defer.resolve(response);
    }).fail(function (err) {
        defer.reject(new Error());
    });

    return defer.promise;
};

yandexMusic.prototype.browsePlaylist = function (playlist_id) {
    var self = this;
    var defer = libQ.defer();

    if (!self.playlists[playlist_id]) {
        self.playlists[playlist_id] = new playlist(self.client, self.uid, playlist_id, 'playlist', self.logger);
        self.playlists[playlist_id].title = self.titles[playlist_id];
    }

    self.playlists[playlist_id].fetch().then(function (tracks) {
        var response = {
            navigation: {
                lists: [
                    {
                        "availableListViews": ["list"],
                        "type": "playlist",
                        "title": self.playlists[playlist_id].title,
                        "items": tracks
                    }
                ]
            }
        };
        defer.resolve(response);
    }).fail(function (err) {
        defer.reject(new Error());
    });

    return defer.promise;
};

yandexMusic.prototype.browseArtist = function (playlist_id) {
    var self = this;
    var defer = libQ.defer();

    var internal_id = 'a' + playlist_id;

    if (!self.playlists[internal_id]) {
        self.playlists[internal_id] = new playlist(self.client, self.uid, playlist_id, 'artist', self.logger);
    }

    self.playlists[internal_id].fetch().then(function (tracks) {
        var response = {
            navigation: {
                lists: [
                    {
                        "availableListViews": ["list"],
                        "type": "folder",
                        "title": self.playlists[internal_id].title,
                        "items": tracks
                    }
                ]
            }
        };
        defer.resolve(response);
    }).fail(function (err) {
        defer.reject(new Error());
    });

    return defer.promise;
};

yandexMusic.prototype.browseAlbum = function (playlist_id) {
    var self = this;
    var defer = libQ.defer();

    if (!self.playlists[playlist_id]) {
        self.playlists[playlist_id] = new playlist(self.client, self.uid, playlist_id, 'album', self.logger);
    }

    self.playlists[playlist_id].fetch().then(function (tracks) {
        var response = {
            navigation: {
                lists: [
                    {
                        "availableListViews": ["list"],
                        "type": "folder",
                        "title": self.playlists[playlist_id].title,
                        "items": tracks
                    }
                ]
            }
        };
        defer.resolve(response);
    }).fail(function (err) {
        defer.reject(new Error());
    });

    return defer.promise;
};

yandexMusic.prototype.onTrackChanging = function(track) {
    var self = this;

    var now = new Date().getTime();

    if (self.current_track) {
        var p = self.playlists[self.current_track.playlist_id];
        if (p && p.type == 'radio') {
            var played = (now - self.current_track.start) / 1000;
            var is_finished = Math.abs(played - self.current_track.duration) < 8;
            p.onEndTrack(self.current_track.track_id, played, is_finished).then(function () {
                p.fetch().then(function (tracks) {
                    for (var i = 0; i < p.new_tracks.length; ++i) {
                        self.commandRouter.addQueueItems([{
                            uri: p.new_tracks[i].uri,
                            service: 'yam',
                        }]);
                    }
                }).fail(function (err) {
                });
            });
        }
    };

    var track_id = track.uri.split('/').pop();
    var ids = track_id.split('@');
    var playlist_id = (ids.length > 0) ? ids[1] : '';

    self.current_track = Object.assign({}, track);
    self.current_track.track_id = track_id;
    self.current_track.playlist_id = playlist_id;
    self.current_track.start = now;
};

yandexMusic.prototype.onTrackChanged = function() {
    var self = this;

    if (self.current_track && self.current_track.track_id && self.current_track.playlist_id) {
        var p = self.playlists[self.current_track.playlist_id];
        if (p && p.type == 'radio') {
            p.onStartTrack(self.current_track.track_id);
        }
    }
};

// Define a method to clear, add, and play an array of tracks
yandexMusic.prototype.clearAddPlayTrack = function(track) {
    var self = this;

    self.onTrackChanging(track);

    var track_id = track.uri.split('/').pop();
    var ids = track_id.split('@');
    var playlist_id = (ids.length > 0) ? ids[1] : '';
    var track_uri;

    self.positionAtPrefetch = -1;

    return self.mpdPlugin.sendMpdCommand('stop', [])
        .then(function () {
            return self.mpdPlugin.sendMpdCommand('clear', []);
        })
        .then(function () {
            return getTrackUrl(self.client, track_id, self.hq, self.logger, self.proxy.port);
        })
        .then(function (data) {
            track_uri = data.uri;
            track.codec = data.codec;
            track.bitrate = data.bitrate;
            return self.mpdPlugin.sendMpdCommand('addid "' + track_uri + '"', []);
        })
        .then(function (resp)  {
            if (resp && typeof resp.Id != undefined) {
                var cmds = [
                    {command: 'addtagid', parameters: [resp.Id, 'title', track.title]},
                    {command: 'addtagid', parameters: [resp.Id, 'album', track.album]},
                    {command: 'addtagid', parameters: [resp.Id, 'artist', track.artist]}
                ];
                return self.mpdPlugin.sendMpdCommandArray(cmds);
            } else {
                return libQ.resolve();
            }
        })
        .then(function () {
            self.commandRouter.stateMachine.setConsumeUpdateService('mpd');
            return self.mpdPlugin.sendMpdCommand('play', []);
        })
        .then(function () {
            self.onTrackChanged();
            return libQ.resolve();
        });
};

// Prefetch for gapless Playback
yandexMusic.prototype.prefetch = function(track) {
    var self = this;

    self.onTrackChanging(track);

    var track_id = track.uri.split('/').pop();

    self.positionAtPrefetch = self.commandRouter.stateMachine.currentPosition;

    return getTrackUrl(self.client, track_id, self.hq, self.logger, self.proxy.port)
        .then(function (data) {
            return self.mpdPlugin.sendMpdCommand('addid "' + data.uri + '"', [])
        })
        .then(function (resp)  {
            if (resp && typeof resp.Id != undefined) {
                var cmds = [
                    {command: 'addtagid', parameters: [resp.Id, 'title', track.title]},
                    {command: 'addtagid', parameters: [resp.Id, 'album', track.album]},
                    {command: 'addtagid', parameters: [resp.Id, 'artist', track.artist]}
                ];
                return self.mpdPlugin.sendMpdCommandArray(cmds);
            } else {
                return libQ.resolve();
            }
        })
        .then(function () {
            return self.mpdPlugin.sendMpdCommand('consume 1', []);
        })
        .then(function () {
            self.onTrackChanged();
            return libQ.resolve();
        });
}

// volumioPushState callback
yandexMusic.prototype.onPushState = function (state) {
    var self = this;

    // Volumio 3 increasePlaybackTimer set isConsume to false,
    // and prefetched track does not display metadata
    if (self.positionAtPrefetch >= 0) {
        if (state && state.service == 'yam') {
            self.commandRouter.stateMachine.setConsumeUpdateService('mpd');
            self.positionAtPrefetch = -1;
        }
    }
}

// Seek
yandexMusic.prototype.seek = function (timepos) {
    var self = this;

    return self.mpdPlugin.seek(timepos);
};

// Stop
yandexMusic.prototype.stop = function() {
    var self = this;

    self.commandRouter.stateMachine.setConsumeUpdateService('mpd');
    return self.mpdPlugin.stop();
};

// Pause
yandexMusic.prototype.pause = function() {
    var self = this;

    self.commandRouter.stateMachine.setConsumeUpdateService('mpd');
    return self.mpdPlugin.pause();
};

// Resume
yandexMusic.prototype.resume = function () {
    var self = this;

    self.commandRouter.stateMachine.setConsumeUpdateService('mpd');
    return self.mpdPlugin.resume();
};

// Next
yandexMusic.prototype.next = function() {
    var self = this;

    self.commandRouter.stateMachine.setConsumeUpdateService('mpd');
    return self.mpdPlugin.next();
}

// Previous
yandexMusic.prototype.previous = function() {
    self.commandRouter.stateMachine.setConsumeUpdateService('mpd');
    return self.mpdPlugin.previous();
}

// Get state
yandexMusic.prototype.getState = function() {
};

//Parse state
yandexMusic.prototype.parseState = function(sState) {
};

// Announce updated State
yandexMusic.prototype.pushState = function(state) {
    return this.commandRouter.servicePushState(state, 'yam');
};

yandexMusic.prototype.explodeUri = function(curUri) {
    var self = this;

    // No wait for it
    self.checkUid();

    var response;
    var uriParts = curUri.split('/');

    if (curUri.startsWith('yam')) {
        if (curUri.startsWith('yam/track/')) {
            var track_id = uriParts.pop();
            var ids = track_id.split('@');
            var playlist_id = (ids.length > 0) ? ids[1] : '';
            var p = self.playlists[playlist_id];
            if (!p) {
                p = new playlist(self.client, self.uid);
            }
            response = p.explodeTrack(curUri);
        } else if (curUri.startsWith('yam/myplaylists')) {
            var defer = libQ.defer();
            self.client.user.getPlayLists(self.uid).then(function (resp) {
                var promises = [];
                for (var i = 0; i < resp.result.length; ++i) {
                    var id = resp.result[i].uid + ':' + resp.result[i].kind;
                    if (!self.playlists[id]) {
                        self.playlists[id] = new playlist(self.client, self.uid, id, 'playlist', self.logger);
                    }
                    promises.push(self.playlists[id].fetch());
                }
                libQ.all(promises).then(function (playlist_tracks) {
                    var tracks = [];
                    for (var i = 0; i < playlist_tracks.length; ++i) {
                        tracks = tracks.concat(playlist_tracks[i]);
                    }
                    defer.resolve(tracks);
                }).fail(function (err) {
                    defer.reject(new Error(err));
                });
            }).catch(function (err) {
                defer.reject(new Error(err));
            });
            response = defer.promise;
        } else if (curUri.startsWith('yam/radio/')) {
            var playlist_id = uriParts.pop();
            if (!self.playlists[playlist_id]) {
                self.playlists[playlist_id] = new playlist(self.client, self.uid, playlist_id, 'radio', self.logger);
            }
            response = self.playlists[playlist_id].fetch();
        } else if (curUri.startsWith('yam/playlist/')) {
            var playlist_id = uriParts.pop();
            if (!self.playlists[playlist_id]) {
                self.playlists[playlist_id] = new playlist(self.client, self.uid, playlist_id, 'playlist', self.logger);
            }
            response = self.playlists[playlist_id].fetch();
        } else if (curUri.startsWith('yam/artist/')) {
            var defer = libQ.defer();
            var playlist_id = uriParts.pop();
            var internal_id = 'a' + playlist_id;
            if (!self.playlists[internal_id]) {
                self.playlists[internal_id] = new playlist(self.client, self.uid, playlist_id, 'artist', self.logger);
            }
            self.playlists[internal_id].fetch().then(function (albums) {
                var promises = [];
                for (var i = 0; i < albums.length; ++i) {
                    var id = albums[i].id;
                    if (!self.playlists[id]) {
                        self.playlists[id] = new playlist(self.client, self.uid, id, 'album', self.logger);
                    }
                    promises.push(self.playlists[id].fetch());
                }
                libQ.all(promises).then(function (album_tracks) {
                    var tracks = [];
                    for (var i = 0; i < album_tracks.length; ++i) {
                        tracks = tracks.concat(album_tracks[i]);
                    }
                    defer.resolve(tracks);
                }).fail(function (err) {
                    defer.reject(new Error(err));
                });
            }).fail(function (err) {
                defer.reject(new Error(err));
            });
            response = defer.promise;
        } else if (curUri.startsWith('yam/album/')) {
            var playlist_id = uriParts.pop();
            if (!self.playlists[playlist_id]) {
                self.playlists[playlist_id] = new playlist(self.client, self.uid, playlist_id, 'album', self.logger);
            }
            response = self.playlists[playlist_id].fetch();
        } else {
            response = libQ.reject();
        }
    } else {
        response = libQ.reject();
    }

    return response;
};

yandexMusic.prototype.getAlbumArt = function (data, path) {

    var artist, album;

    if (data != undefined && data.path != undefined) {
        path = data.path;
    }

    var web;

    if (data != undefined && data.artist != undefined) {
        artist = data.artist;
        if (data.album != undefined)
            album = data.album;
        else album = data.artist;

        web = '?web=' + nodetools.urlEncode(artist) + '/' + nodetools.urlEncode(album) + '/large'
    }

    var url = '/albumart';

    if (web != undefined)
        url = url + web;

    if (web != undefined && path != undefined)
        url = url + '&';
    else if (path != undefined)
        url = url + '?';

    if (path != undefined)
        url = url + 'path=' + nodetools.urlEncode(path);

    return url;
};

yandexMusic.prototype.search = function (query) {
    return this._search(query.value, 'all');
};

yandexMusic.prototype._search = function (text, type) {
    var self = this;
    var defer = libQ.defer();

    self.client.search.search(text, 0, type, false).then(function (resp) {
        var response = {
            "title": self.getI18n('SEARCH_RESULTS'),
            "icon": "fa fa-music",
            "availableListViews": ["list", "grid"],
            "items": [
            ]
        };

        var p = new playlist(self.client, self.uid);
        var items;
        var block;

        block = resp.result.best;
        if (block && (block.type == 'artist' || block.type == 'album')) {
            response.items.push({"type": "title", "title": self.getI18n('SEARCH_BEST_SECTION')});
            if (block.type == 'artist') {
                response.items.push(p.artistToArtist(block.result));
            }
            if (block.type == 'album') {
                response.items.push(p.albumToAlbum(block.result));
            }
        }

        block = resp.result.artists;
        if (block && block.results.length > 0) {
            response.items.push({"type": "title", "title": self.getI18n('SEARCH_ARTISTS_SECTION')});
            items = block.results.map(function (x) { return p.artistToArtist(x); });
            for (var i = 0; i < items.length; ++i) {
                response.items.push(items[i]);
            }
        }

        block = resp.result.albums;
        if (block && block.results.length > 0) {
            response.items.push({"type": "title", "title": self.getI18n('SEARCH_ALBUMS_SECTION')});
            items = block.results.map(function (x) { return p.albumToAlbum(x); });
            for (var i = 0; i < items.length; ++i) {
                response.items.push(items[i]);
            }
        }

        block = resp.result.tracks;
        if (block && block.results.length > 0) {
            response.items.push({"type": "title", "title": self.getI18n('SEARCH_SONGS_SECTION')});
            items = block.results.map(function (x) { return p.trackToFolder(x); });
            for (var i = 0; i < items.length; ++i) {
                response.items.push(items[i]);
            }
        }

        defer.resolve(response);
    }).catch(function (err) {
        defer.reject(new Error());
    });

    return defer.promise;
};

yandexMusic.prototype.goto = function(data){
    var self = this;
    var defer = libQ.defer();

    self._search(data.value, data.type).then(function (data) {
        var response = {
            navigation: {
                lists: [
                    data 
                ]
            }
        };
        defer.resolve(response);
    }).fail(function (err) {
        defer.reject(new Error());
    });

    return defer.promise;
};
