'use strict';

const Io = require('socket.io');

const { Router } = require('express');

const { randomBytes } = require('crypto');

const { spawn, ChildProcess } = require('child_process');

const Mp4Frag = require('mp4frag');

Mp4Frag.prototype.toJSON = function () {
  return {
    hlsPlaylist: {
      base: this._hlsPlaylistBase,
      init: this._hlsPlaylistInit,
      size: this._hlsPlaylistSize,
      extra: this._hlsPlaylistExtra,
    },
    segmentCount: this._segmentCount,
    sequence: this._sequence,
    duration: this._duration,
    timestamp: this._timestamp,
    audioCodec: this._audioCodec,
    videoCodec: this._videoCodec,
  };
};

module.exports = RED => {
  const { server, settings, _ } = RED;

  const {
    mp4frag: { httpMiddleware = null, ioMiddleware = null, sizeLimit = 5000000, timeLimit = 10000 },
  } = settings;

  const { createNode, registerType } = RED.nodes;

  class Mp4fragNode {
    constructor(config) {
      createNode(this, config);

      this.basePath = config.basePath;

      this.hlsPlaylistSize = config.hlsPlaylistSize;

      this.hlsPlaylistExtra = config.hlsPlaylistExtra;

      this.processVideo = config.processVideo === true;

      this.commandPath = Mp4fragNode.validateCommandPath(config.commandPath);

      this.commandArgs = Mp4fragNode.validateCommandArgs(config.commandArgs);

      this.writing = false;

      try {
        this.createPaths(); // throws

        this.createMp4frag(); // throws

        this.createHttpRoute();

        this.createIoServer();

        this.on('input', this.onInput);

        this.on('close', this.onClose);

        this.status({ fill: 'green', shape: 'ring', text: _('mp4frag.info.ready') });
      } catch (err) {
        this.error(err);

        this.status({ fill: 'red', shape: 'dot', text: err.toString() });
      }
    }

    createPaths() {
      if (this.id !== this.basePath && Mp4fragNode.basePathRegex.test(this.basePath) === false) {
        throw new Error(_('mp4frag.error.base_path_invalid', { basePath: this.basePath }));
      }

      if (typeof Mp4fragNode.basePathMap === 'undefined') {
        Mp4fragNode.basePathMap = new Map();
      } else {
        const item = Mp4fragNode.basePathMap.get(this.basePath);

        if (typeof item !== 'undefined' && item !== this.id) {
          throw new Error(_('mp4frag.error.base_path_duplicate', { basePath: this.basePath }));
        }
      }

      Mp4fragNode.basePathMap.set(this.basePath, this.id);

      this.hlsPlaylistPath = `/mp4frag/${this.basePath}/hls.m3u8`;

      this.mp4VideoPath = `/mp4frag/${this.basePath}/video.mp4`;

      this.ioNamespace = `/${this.basePath}`;
    }

    destroyPaths() {
      Mp4fragNode.basePathMap.delete(this.basePath);

      this.hlsPlaylistPath = undefined;

      this.mp4VideoPath = undefined;

      this.ioNamespace = undefined;
    }

    createMp4frag() {
      this.mp4frag = new Mp4Frag({
        hlsPlaylistBase: 'hls',
        hlsPlaylistSize: this.hlsPlaylistSize,
        hlsPlaylistExtra: this.hlsPlaylistExtra,
        hlsPlaylistInit: true,
      });

      this.mp4frag.on('initialized', data => this.onInitialized(data));

      this.mp4frag.on('segment', data => this.onSegment(data));

      this.mp4frag.on('error', err => this.onError(err));

      this.mp4frag.on('reset', () => this.onReset());
    }

    destroyMp4frag() {
      this.mp4frag.removeAllListeners('initialized');

      this.mp4frag.removeAllListeners('segment');

      this.mp4frag.removeAllListeners('error');

      this.mp4frag.removeAllListeners('reset');

      this.mp4frag.resetCache();

      this.mp4frag = undefined;
    }

    createIoServer() {
      if (typeof Mp4fragNode.ioServer === 'undefined') {
        Mp4fragNode.ioServer = Io(server, {
          path: Mp4fragNode.ioPath,
          transports: ['websocket' /* , 'polling'*/],
        });
      }

      if (typeof Mp4fragNode.ioMiddleware === 'undefined') {
        Mp4fragNode.ioMiddleware = ioMiddleware;
      }

      this.ioKey = randomBytes(15).toString('hex');

      this.ioSocketWaitingForSegments = new Map();

      this.ioServerOfNamespace = Mp4fragNode.ioServer.of(this.ioNamespace);

      if (typeof Mp4fragNode.ioMiddleware === 'function') {
        this.ioServerOfNamespace.use(Mp4fragNode.ioMiddleware);
      } else if (Array.isArray(Mp4fragNode.ioMiddleware)) {
        Mp4fragNode.ioMiddleware.forEach(middleware => {
          this.ioServerOfNamespace.use(middleware);
        });
      } else {
        this.ioServerOfNamespace.use((socket, next) => {
          if (typeof socket.handshake.auth === 'object') {
            if (this.ioKey !== socket.handshake.auth.key) {
              const err = new Error('not authorized');

              err.data = { reason: 'auth key invalid' };

              return setTimeout(() => {
                next(err);
              }, 5000);
            }

            socket.authenticated = true;
          } else {
            socket.authenticated = false;
          }

          next();
        });
      }

      this.ioServerOfNamespace.on('connect' /* or connection */, socket => {
        // might send ack to verify round trip

        // connect -> auth -> mime -> initialization -> segments...

        const onAuthenticated = () => {
          socket.on('mime', () => {
            if (typeof this.mp4frag === 'undefined') {
              return socket.emit('mp4frag_error', _('mp4frag.error.mp4frag_not_found', { basePath: this.basePath }));
            }

            const { mime } = this.mp4frag;

            if (mime === null) {
              return socket.emit('mp4frag_error', _('mp4frag.error.mime_not_found', { basePath: this.basePath }));
            }

            socket.emit('mime', mime);
          });

          socket.on('initialization', () => {
            if (typeof this.mp4frag === 'undefined') {
              return socket.emit('mp4frag_error', _('mp4frag.error.mp4frag_not_found', { basePath: this.basePath }));
            }

            const { initialization } = this.mp4frag;

            if (initialization === null) {
              return socket.emit('mp4frag_error', _('mp4frag.error.initialization_not_found', { basePath: this.basePath }));
            }

            socket.emit('initialization', initialization);
          });

          socket.on('segment', (data = {}) => {
            if (typeof this.mp4frag === 'undefined') {
              return socket.emit('mp4frag_error', _('mp4frag.error.mp4frag_not_found', { basePath: this.basePath }));
            }

            if (typeof data.timestamp === 'number') {
              const { segmentObject } = this.mp4frag;

              if (segmentObject.timestamp > data.timestamp) {
                socket.emit('segment', segmentObject);
              } else {
                this.ioSocketWaitingForSegments.set(socket, false);
              }
            } else {
              const { duration, timestamp, sequence } = this.mp4frag;

              const startIndex = data.buffered === true ? 0 : -1;

              const buffer = this.mp4frag.getSegmentList(startIndex, true);

              if (Buffer.isBuffer(buffer)) {
                socket.emit('segment', { segment: buffer, duration, timestamp, sequence });

                if (data.all !== false) {
                  this.ioSocketWaitingForSegments.set(socket, true);
                }
              } else {
                this.ioSocketWaitingForSegments.set(socket, data.all !== false);
              }
            }
          });

          socket.on('disconnect', data => {
            this.ioSocketWaitingForSegments instanceof Map && this.ioSocketWaitingForSegments.delete(socket);
          });

          socket.emit('auth', true);
        };

        if (socket.authenticated === true) {
          onAuthenticated();
        } else {
          // todo add timer waiting for auth response from client

          socket.once('auth', (data = {}) => {
            const { key } = data;

            if (this.ioKey === key) {
              onAuthenticated();
            } else {
              setTimeout(() => socket.disconnect(true), 5000);
            }
          });

          socket.emit('auth', false);
        }
      });
    }

    destroyIoServer() {
      const sockets =
        this.ioServerOfNamespace.sockets instanceof Map
          ? this.ioServerOfNamespace.sockets
          : Object.values(this.ioServerOfNamespace.sockets);

      sockets.forEach(socket => {
        if (socket.connected === true) {
          socket.disconnect(true);
        }
      });

      this.ioServerOfNamespace.removeAllListeners();

      this.ioServerOfNamespace = undefined;

      this.ioSocketWaitingForSegments.clear();

      this.ioSocketWaitingForSegments = undefined;

      this.ioKey = undefined;

      if (Mp4fragNode.ioServer._nsps instanceof Map) {
        Mp4fragNode.ioServer._nsps.delete(this.ioNamespace);
      } else {
        Mp4fragNode.ioServer.nsps[this.ioNamespace] = undefined;
      }
    }

    createHttpRoute() {
      if (typeof Mp4fragNode.router === 'undefined') {
        Mp4fragNode.router = Router({ caseSensitive: true });

        Mp4fragNode.router.mp4fragRouter = true;

        Mp4fragNode.httpMiddleware = httpMiddleware;

        if (Mp4fragNode.httpMiddleware !== null) {
          Mp4fragNode.router.use(Mp4fragNode.httpMiddleware);
        }

        Mp4fragNode.router.get('/', (req, res) => {
          let basePathArray = Array.from(Mp4fragNode.basePathMap);

          res.type('json').send(JSON.stringify(basePathArray, null, 2));

          // todo filter response based on user level/access
          /* const { access } = res.locals;

          if (Array.isArray(access) === false || access.length === 0 || access.includes('all')) {
            return res.type('json').send(JSON.stringify(basePathArray, null, 2));
          }

          basePathArray = basePathArray.filter(( el ) => access.includes( el[0] ));

          res.type('json').send(JSON.stringify(basePathArray, null, 2));*/
        });

        RED.httpNode.use('/mp4frag', Mp4fragNode.router);
      }

      this.resWaitingForSegments = new Set();

      const pattern = `^\/${this.basePath}/(?:(hls.m3u8)|hls([0-9]+).m4s|(init-hls.mp4)|(hls.m3u8.txt)|(video.mp4)|(api.json))$`;

      this.routePath = new RegExp(pattern, 'i');

      const endpoint = (req, res) => {
        if (typeof this.mp4frag === 'undefined') {
          return res.status(404).send(_('mp4frag.error.mp4frag_not_found', { basePath: this.basePath }));
        }

        const { params } = req;

        if (params[0]) {
          const { m3u8 } = this.mp4frag;

          if (m3u8) {
            res.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');

            res.set('Expires', '-1');

            res.set('Pragma', 'no-cache');

            res.type('m3u8');

            return res.send(m3u8);
          }

          return res.status(404).send(_('mp4frag.error.m3u8_not_found', { basePath: this.basePath }));
        }

        if (params[1]) {
          const sequence = params[1];

          const segment = this.mp4frag.getSegment(sequence);

          if (segment) {
            // res.type('m4s'); <-- not yet supported, filed issue https://github.com/jshttp/mime-db/issues/216

            // res.type('mp4');

            res.set('Content-Type', 'video/iso.segment');

            return res.send(segment);
          }

          return res.status(404).send(_('mp4frag.error.segment_not_found', { sequence, basePath: this.basePath }));
        }

        if (params[2]) {
          const { initialization } = this.mp4frag;

          if (initialization) {
            res.type('mp4');

            return res.send(initialization);
          }

          return res.status(404).send(_('mp4frag.error.initialization_not_found', { basePath: this.basePath }));
        }

        if (params[3]) {
          const { m3u8 } = this.mp4frag;

          if (m3u8) {
            res.type('txt');

            return res.send(m3u8);
          }

          return res.status(404).send(_('mp4frag.error.m3u8_not_found', { basePath: this.basePath }));
        }

        if (params[4]) {
          const { initialization } = this.mp4frag;

          if (!initialization) {
            return res.status(404).send(_('mp4frag.error.initialization_not_found', { basePath: this.basePath }));
          }

          res.type('mp4');

          res.write(initialization);

          const buffer = this.mp4frag.getSegmentList(-1, true);

          if (Buffer.isBuffer(buffer)) {
            res.write(buffer);
          }

          res.flush();

          this.resWaitingForSegments.add(res);

          res.once('close', () => {
            this.resWaitingForSegments instanceof Set && this.resWaitingForSegments.delete(res);

            res.end();
          });

          return;
        }

        if (params[5]) {
          res.type('json');

          res.send(JSON.stringify({ payload: this.payload, mp4frag: this.mp4frag }, null, 2));
        }
      };

      Mp4fragNode.router.route(this.routePath).get(endpoint);
    }

    destroyHttpRoute() {
      if (this.resWaitingForSegments.size > 0) {
        this.resWaitingForSegments.forEach(res => {
          if (res.writableEnded === false || res.finished === false) {
            res.end();
          }
        });

        this.resWaitingForSegments.clear();
      }

      this.resWaitingForSegments = undefined;

      const { stack } = Mp4fragNode.router;

      for (let i = stack.length - 1; i >= 0; --i) {
        const layer = stack[i];

        const path = layer.route && layer.route.path;

        if (typeof path !== 'undefined' && path === this.routePath) {
          stack.splice(i, 1);

          break;
        }
      }

      /* const { stack } = RED.httpNode._router;

      for (let i = stack.length - 1; i >= 0; --i) {
        const layer = stack[i];

        if (layer.name === 'router' && layer.handle && layer.handle.mp4fragRouter === true) {

          // remove router
          stack.splice(i, 1);

          break;
        }

      }*/
    }

    destroy() {
      this.removeListener('input', this.onInput);

      this.removeListener('close', this.onClose);

      this.stopWriting();

      this.destroyHttpRoute();

      this.destroyIoServer();

      this.destroyMp4frag();

      this.destroyPaths();

      this.payload = '';

      this.send({ /* topic: 'set_source', */ payload: this.payload });
    }

    onInput(msg) {
      const { payload, action } = msg;

      if (Buffer.isBuffer(payload)) {
        return this.mp4frag.write(payload);
      }

      if (typeof action === 'object') {
        const { subject } = action;

        if (subject === 'write') {
          const { command = 'stop' } = action;

          if (command === 'start') {
            if (this.mp4frag.initialization === null) {
              return;
            }

            const startTime = Date.now();

            const sizeLimit =
              Number.isInteger(action.sizeLimit) && action.sizeLimit > 0
                ? Math.min(action.sizeLimit, Mp4fragNode.sizeLimit)
                : Mp4fragNode.sizeLimit;

            const timeLimit =
              Number.isInteger(action.timeLimit) && action.timeLimit > 0
                ? Math.min(action.timeLimit, Mp4fragNode.timeLimit)
                : Mp4fragNode.timeLimit;

            const endTime = startTime + timeLimit;

            const byteLength = 0;

            if (this.writing) {
              this.endTime = endTime;

              this.byteLength = byteLength;

              this.sizeLimit = sizeLimit;
            } else {
              const { keyframe = -1, filename = `${this.processVideo ? 'p' : 'r'}${startTime}.mp4` } = action;

              if (this.processVideo) {
                const spawned = spawn(this.commandPath, this.commandArgs);

                spawned.once('error', err => {
                  this.error(err);

                  this.status({ fill: 'red', shape: 'dot', text: err.toString() });
                });

                if (typeof spawned.pid === 'number') {
                  this.spawned = spawned;

                  spawned.once('close', close => {
                    spawned.removeAllListeners('error');

                    spawned.stdin.removeAllListeners('error');

                    spawned.stdout.removeAllListeners('data');

                    spawned.stdout.removeAllListeners('close');
                  });

                  spawned.stdout.on('data', data => this.send([null, { payload: data, filename }]));

                  // todo stdin will error if pipe:0 not passed in args
                  spawned.stdin.on('error', err => {
                    if (spawned.exitCode === null) {
                      if (this.spawned === spawned) {
                        this.error(err);

                        this.status({ fill: 'red', shape: 'dot', text: err.toString() });

                        this.stopWriting();
                      } else {
                        spawned.kill();
                      }
                    }
                  });

                  const buffer = this.mp4frag.getBuffer(keyframe, true);

                  if (Buffer.isBuffer(buffer)) {
                    spawned.stdin.write(buffer);
                  }

                  this.byteLength = byteLength;

                  this.sizeLimit = sizeLimit;

                  this.endTime = endTime;

                  this.mp4fragWriter = segment => {
                    if (spawned instanceof ChildProcess && spawned.exitCode === null) {
                      spawned.stdin.write(segment);

                      if ((this.byteLength += segment.byteLength) >= this.sizeLimit || Date.now() >= this.endTime) {
                        this.stopWriting();
                      }
                    }
                  };

                  this.writing = true;
                }
              } else {
                this.send([null, { payload: buffer, filename }]);

                this.byteLength = byteLength;

                this.sizeLimit = sizeLimit;

                this.endTime = endTime;

                this.mp4fragWriter = segment => {
                  this.send([null, { payload: segment, filename }]);

                  if ((this.byteLength += segment.byteLength) >= this.sizeLimit || Date.now() >= this.endTime) {
                    this.stopWriting();
                  }
                };

                this.writing = true;
              }
            }
          } else {
            this.stopWriting();
          }
        }

        return;
      }

      const { code, signal } = payload;

      // current method for resetting cache, grab exit code or signal from exec
      if (typeof code !== 'undefined' || typeof signal !== 'undefined') {
        this.stopWriting();

        this.mp4frag.resetCache();

        this.payload = '';

        this.send({ /* topic: 'set_source', */ payload: this.payload });

        return this.status({ fill: 'green', shape: 'ring', text: _('mp4frag.info.reset') });
      }

      // temporarily log unknown payload as warning for debugging
      this.warn(_('mp4frag.warning.unknown_payload', { payload }));

      this.status({ fill: 'yellow', shape: 'dot', text: _('mp4frag.warning.unknown_payload', { payload }) });
    }

    onClose(removed, done) {
      this.destroy();

      if (removed) {
        this.status({ fill: 'grey', shape: 'ring', text: _('mp4frag.info.removed') });
      } else {
        this.status({ fill: 'grey', shape: 'dot', text: _('mp4frag.info.closed') });
      }

      done();
    }

    onInitialized(data) {
      this.status({ fill: 'green', shape: 'dot', text: data.mime });
    }

    onSegment(data) {
      const { segment, sequence, duration, keyframe } = data;

      if (sequence === 0) {
        this.payload = {
          hlsPlaylist: this.hlsPlaylistPath,
          mp4Video: this.mp4VideoPath,
          socketIo: { path: Mp4fragNode.ioPath, namespace: this.ioNamespace, key: this.ioKey },
        };

        this.send({ payload: this.payload });
      }

      // trigger time range error
      /* if (sequence % 50 === 0) {
        return;
      }*/

      if (this.ioSocketWaitingForSegments.size > 0) {
        this.ioSocketWaitingForSegments.forEach((all, socket, map) => {
          if (socket.connected === true) {
            socket.emit('segment', data);

            if (all === false) {
              this.ioSocketWaitingForSegments.delete(socket);
            }
          } else {
            this.ioSocketWaitingForSegments.delete(socket);
          }
        });
      }

      if (this.resWaitingForSegments.size > 0) {
        this.resWaitingForSegments.forEach(res => {
          if (res.writableEnded === false || res.finished === false) {
            res.write(segment);

            res.flush();
          }
        });
      }

      if (this.writing) {
        this.mp4fragWriter(segment);
      }

      this.status({
        fill: this.writing ? 'yellow' : 'green',
        shape: 'dot',
        text: _('mp4frag.info.segment', { sequence, duration: duration.toFixed(2), keyframe: keyframe > -1 }),
      });
    }

    onReset() {
      if (this.resWaitingForSegments.size > 0) {
        this.resWaitingForSegments.forEach(res => {
          if (res.writableEnded === false || res.finished === false) {
            res.end();
          }
        });
      }
    }

    onError(err) {
      this.stopWriting();

      this.mp4frag.resetCache();

      this.error(err);

      this.status({ fill: 'red', shape: 'dot', text: err.toString() });
    }

    stopWriting() {
      if (this.writing === true) {
        this.writing = false;

        this.mp4fragWriter = undefined;

        this.byteLength = undefined;

        this.sizeLimit = undefined;

        this.endTime = undefined;

        if (this.spawned instanceof ChildProcess) {
          const spawned = this.spawned;

          this.spawned = undefined;

          if (spawned.exitCode === null) {
            setTimeout(() => {
              if (spawned.exitCode === null) {
                spawned.kill();
              }
            }, 1000);

            spawned.stdin.end();
          }
        }
      }
    }

    static validateCommandPath(commandPath) {
      return Mp4fragNode.commandPathRegex.test(commandPath) ? commandPath : Mp4fragNode.commandPath;
    }

    static validateCommandArgs(commandArgs) {
      try {
        const array = JSON.parse(commandArgs);
        if (Array.isArray(array) && array.length > 0) {
          return array;
        }
      } catch (e) {
        // do nothing, maybe log
      }
      return Mp4fragNode.commandArgs;
    }
  }

  Mp4fragNode.commandPathRegex = /ffmpeg/i;

  Mp4fragNode.commandPath = 'ffmpeg';

  Mp4fragNode.commandArgs = [
    '-loglevel',
    'quiet',
    '-f',
    'mp4',
    '-i',
    'pipe:0',
    '-f',
    'mp4',
    '-c',
    'copy',
    '-movflags',
    '+faststart+empty_moov',
    'pipe:1',
  ];

  Mp4fragNode.basePathRegex = /^[a-z0-9_.]{1,50}$/i;

  Mp4fragNode.basePathMap = undefined;

  Mp4fragNode.ioPath = '/mp4frag/socket.io';

  Mp4fragNode.ioServer = undefined;

  Mp4fragNode.ioMiddleware = undefined;

  Mp4fragNode.httpMiddleware = undefined;

  Mp4fragNode.router = undefined;

  Mp4fragNode.sizeLimit = Number.isInteger(sizeLimit) && sizeLimit > 0 ? sizeLimit : 5000000; // 10 mb

  Mp4fragNode.timeLimit = Number.isInteger(timeLimit) && timeLimit > 0 ? timeLimit : 10000; // 10 seconds

  Mp4fragNode.type = 'mp4frag';

  const Mp4fragSettings = {
    settings: {
      mp4fragSizeLimit: {
        value: Mp4fragNode.sizeLimit,
        exportable: true,
      },
      mp4fragTimeLimit: {
        value: Mp4fragNode.timeLimit,
        exportable: true,
      },
    },
  };

  registerType(Mp4fragNode.type, Mp4fragNode, Mp4fragSettings);
};
