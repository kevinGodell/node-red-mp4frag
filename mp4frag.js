'use strict';

const Io = require('socket.io');

const { Router } = require('express');

const { randomBytes } = require('crypto');

const { spawn } = require('child_process');

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
    mp4frag: { ffmpegPath = 'ffmpeg', httpMiddleware = null, ioMiddleware = null },
  } = settings;

  const { createNode, registerType } = RED.nodes;

  class Mp4fragNode {
    constructor(config) {
      createNode(this, config);

      this.basePath = config.basePath;

      this.hlsPlaylistSize = config.hlsPlaylistSize;

      this.hlsPlaylistExtra = config.hlsPlaylistExtra;

      this.ffmpegRemaster = config.ffmpegRemaster;

      this.ffmpegGlobal = config.ffmpegGlobal;

      this.ffmpegInput = config.ffmpegInput;

      this.ffmpegOutput = config.ffmpegOutput;

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

      this.namespace = `/${this.basePath}`;
    }

    destroyPaths() {
      Mp4fragNode.basePathMap.delete(this.basePath);

      this.hlsPlaylistPath = undefined;

      this.mp4VideoPath = undefined;

      this.namespace = undefined;
    }

    createMp4frag() {
      this.mp4frag = new Mp4Frag({
        hlsPlaylistBase: 'hls',
        hlsPlaylistSize: this.hlsPlaylistSize,
        hlsPlaylistExtra: this.hlsPlaylistExtra,
        hlsPlaylistInit: true,
      });

      this.mp4fragEvents = {
        initialized: this.mp4fragOn('initialized', data => this.onInitialized(data)),
        segment: this.mp4fragOn('segment', data => this.onSegment(data)),
        error: this.mp4fragOn('error', err => this.onError(err)),
        reset: this.mp4fragOn('reset', () => this.onReset()),
      };
    }

    destroyMp4frag() {
      this.mp4frag.off('initialized', this.mp4fragEvents.initialized);

      this.mp4frag.off('segment', this.mp4fragEvents.segment);

      this.mp4frag.off('error', this.mp4fragEvents.error);

      this.mp4frag.off('reset', this.mp4fragEvents.reset);

      this.mp4fragEvents = undefined;

      this.mp4frag.resetCache();

      this.mp4frag = undefined;
    }

    mp4fragOn(type, func) {
      this.mp4frag.on(type, func);

      return func;
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

      this.ioServerOfNamespace = Mp4fragNode.ioServer.of(this.namespace);

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
              if (data.buffered === true) {
                const { segmentList, duration, timestamp, sequence } = this.mp4frag;

                if (segmentList !== null) {
                  socket.emit('segment', { segment: segmentList, duration, timestamp, sequence });

                  if (data.all !== false) {
                    this.ioSocketWaitingForSegments.set(socket, true);
                  }
                } else {
                  this.ioSocketWaitingForSegments.set(socket, data.all !== false);
                }
              } else {
                const { segmentObject } = this.mp4frag;

                if (segmentObject.segment !== null) {
                  socket.emit('segment', segmentObject);

                  if (data.all !== false) {
                    this.ioSocketWaitingForSegments.set(socket, true);
                  }
                } else {
                  this.ioSocketWaitingForSegments.set(socket, data.all !== false);
                }
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
        Mp4fragNode.ioServer._nsps.delete(this.namespace);
      } else {
        Mp4fragNode.ioServer.nsps[this.namespace] = undefined;
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
          console.log(params[4], this.id);

          const { initialization, segment } = this.mp4frag;

          if (!initialization) {
            return res.status(404).send(_('mp4frag.error.initialization_not_found', { basePath: this.basePath }));
          }

          res.type('mp4');

          res.write(initialization);

          if (segment) {
            res.write(segment);
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

    spawnFfmpeg() {}

    destroyFfmpeg() {}

    destroy() {
      this.removeListener('input', this.onInput);

      this.removeListener('close', this.onClose);

      this.destroyHttpRoute();

      this.destroyIoServer();

      this.destroyMp4frag();

      this.destroyPaths();

      this.destroyFfmpeg();

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
          this.writing = false;

          this.filename = undefined;

          if (this.ffmpegSpawn) {
            console.log(typeof this.ffmpegSpawn);

            this.ffmpegSpawn.kill();

            this.ffmpegSpawn = undefined;
          }

          const { command = 'stop', keyframe = 'last', filename = `${Date.now()}.mp4` } = action;

          if (command === 'start') {
            let payload;

            if (keyframe === 'last') {
              payload = this.mp4frag.lastKeyframeBuffer;
            } else if (keyframe === 'first') {
              payload = this.mp4frag.firstKeyframeBuffer;
            } else if (Number.isInteger(keyframe)) {
              // payload = this.mp4frag.getKeyframeBuffer(keyframe);
              /*
                todo
                need to build indexing into mp4frag
                positive int will be from first
                negative int will be from last
              */
            } else {
              console.log('invalid selection');
              return;
            }

            if (Buffer.isBuffer(payload)) {
              if (this.ffmpegRemaster === true) {
                this.ffmpegSpawn = spawn(ffmpegPath, [
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
                ]);

                this.ffmpegSpawn.stdio[1].on('data', data => {
                  console.log({
                    data,
                  });
                });

                this.ffmpegSpawn.stdio[0].write(payload);
              } else {
                this.send([null, { payload, filename }]);
              }

              this.writing = true; // must be after send or spawn (value used in onSegment)

              this.filename = filename; // must be after send or spawn (value used in onSegment)
            }
          }
        }
        return;
      }

      const { code, signal } = payload;

      // current method for resetting cache, grab exit code or signal from exec
      if (typeof code !== 'undefined' || typeof signal !== 'undefined') {
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
        this.status({ fill: 'red', shape: 'ring', text: _('mp4frag.info.removed') });
      } else {
        this.status({ fill: 'red', shape: 'dot', text: _('mp4frag.info.closed') });
      }

      done();
    }

    onInitialized(data) {
      this.status({ fill: 'green', shape: 'dot', text: data.mime });
    }

    onSegment(data) {
      const { segment, sequence, duration } = data;

      if (sequence === 0) {
        this.payload = {
          hlsPlaylist: this.hlsPlaylistPath,
          mp4Video: this.mp4VideoPath,
          socketIo: { path: Mp4fragNode.ioPath, namespace: this.namespace, key: this.ioKey },
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

      if (this.writing === true && typeof this.filename === 'string') {
        // todo write to spawned ffmpeg or send raw buffer to next node
        /* if (typeof this.ffmpegSpawn === 'object') {

        }*/

        this.send([null, { payload: segment, filename: this.filename }]);
      }

      this.status({ fill: 'green', shape: 'dot', text: _('mp4frag.info.segment', { sequence, duration }) });
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
      this.mp4frag.resetCache();

      this.error(err);

      this.status({ fill: 'red', shape: 'dot', text: err.toString() });
    }
  }

  Mp4fragNode.basePathRegex = /^[a-z0-9_.]{1,50}$/i;

  Mp4fragNode.basePathMap = undefined;

  Mp4fragNode.ioPath = '/mp4frag/socket.io';

  Mp4fragNode.ioServer = undefined;

  Mp4fragNode.ioMiddleware = undefined;

  Mp4fragNode.httpMiddleware = undefined;

  Mp4fragNode.type = 'mp4frag';

  Mp4fragNode.router = undefined;

  const Mp4fragMeta = {
    settings: {
      mp4fragFfmpegPath: {
        value: ffmpegPath,
        exportable: true,
      },
    },
  };

  registerType(Mp4fragNode.type, Mp4fragNode, Mp4fragMeta);
};
