'use strict';

const Io = require('socket.io');

const { Router } = require('express');

const { randomBytes } = require('crypto');

const Mp4Frag = require('mp4frag');

const { promisify } = require('util');

const sleep = promisify(setTimeout);

const { name: packageName, version: packageVersion } = require('./package.json');

module.exports = RED => {
  const {
    httpNode,
    server,
    settings,
    _,
    nodes: { createNode, registerType },
    log: { error },
  } = RED;

  class Mp4fragNode {
    constructor(config) {
      createNode(this, config);

      this.basePath = config.basePath === 'id' ? this.id : config.basePath;

      this.hlsPlaylistSize = config.hlsPlaylistSize;

      this.hlsPlaylistExtra = config.hlsPlaylistExtra;

      this.autoStart = config.autoStart === 'true';

      this.repeated = config.repeated === 'true';

      this.timeLimit = Mp4fragNode.getInt(-1, Number.MAX_SAFE_INTEGER, Mp4fragNode.timeLimit, config.timeLimit);

      this.preBuffer = Mp4fragNode.getInt(1, 5, Mp4fragNode.preBuffer, config.preBuffer);

      this.statusLocation = Mp4fragNode.getStatusLocation(config.statusLocation);

      this.writing = false;

      this.status({});

      try {
        this.createPaths(); // throws

        this.createMp4frag(); // throws

        this.createHttpRoute();

        this.createIoServer();

        this.on('input', this.onInput);

        this.on('close', this.onClose);

        this.statusLocation.displayed && this.status({ fill: 'green', shape: 'ring', text: _('mp4frag.info.ready') });

        this.statusLocation.wired && this.send([null, null, { payload: { status: 'ready' } }]);
      } catch (error) {
        this.error(error);

        this.statusLocation.displayed && this.status({ fill: 'red', shape: 'dot', text: err.toString() });

        this.statusLocation.wired && this.send([null, null, { payload: { status: 'error', error } }]);
      }
    }

    createPaths() {
      if (this.id !== this.basePath && Mp4fragNode.basePathRegex.test(this.basePath) === false) {
        throw new Error(_('mp4frag.error.base_path_invalid', { basePath: this.basePath }));
      }

      const item = Mp4fragNode.basePathMap.get(this.basePath);

      if (typeof item === 'object' && item.id !== this.id) {
        throw new Error(_('mp4frag.error.base_path_duplicate', { basePath: this.basePath }));
      }

      Mp4fragNode.basePathMap.set(this.basePath, { id: this.id, running: false });

      this.hlsPlaylistPath = `/mp4frag/${this.basePath}/hls.m3u8`;

      this.mp4VideoPath = `/mp4frag/${this.basePath}/video.mp4`;

      this.ioNamespace = `/${this.basePath}`;

      this.topic = {
        buffer: {
          init: `mp4frag/${this.basePath}/buffer/init`,
          pre: `mp4frag/${this.basePath}/buffer/pre`,
          seg: `mp4frag/${this.basePath}/buffer/seg`,
        },
      };
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

      this.mp4frag.on('initialized', data => {
        const { mime } = data;

        this.statusLocation.displayed && this.status({ fill: 'green', shape: 'dot', text: mime });

        this.statusLocation.wired && this.send([null, null, { payload: { status: 'initialized', mime } }]);

        const item = Mp4fragNode.basePathMap.get(this.basePath);

        item.running = true;
      });

      this.mp4frag.on('segment', data => {
        const { segment, sequence, duration, keyframe, timestamp } = data;

        if (sequence === 0) {
          this.payload = {
            hlsPlaylist: this.hlsPlaylistPath,
            mp4Video: this.mp4VideoPath,
            socketIo: { path: Mp4fragNode.ioPath, namespace: this.ioNamespace, key: this.ioKey },
          };

          this.send({ payload: this.payload });

          if (this.autoStart === true) {
            this.startWriting(this.preBuffer, this.timeLimit, this.repeated);
          }
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

        if (this.writing && this.mp4fragWriter) {
          this.mp4fragWriter(segment, sequence, duration, timestamp);
        }

        const { totalDuration, totalByteLength } = this.mp4frag;

        this.statusLocation.displayed &&
          this.status({
            fill: this.writing ? 'yellow' : 'green',
            shape: 'dot',
            text: _('mp4frag.info.segment', {
              sequence,
              duration: duration.toFixed(2),
              keyframe: keyframe > -1 ? 1 : 0,
              totalDuration: totalDuration.toFixed(2),
              totalByteLength: (totalByteLength / 1000000).toFixed(2),
            }),
          });

        this.statusLocation.wired && this.send([null, null, { payload: { status: 'segment', sequence, duration, keyframe, totalDuration, totalByteLength } }]);
      });

      this.mp4frag.on('error', async error => {
        await this.stopWriting();

        this.mp4frag.resetCache();

        // this.error(error);

        this.statusLocation.displayed && this.status({ fill: 'red', shape: 'dot', text: error.toString() });

        this.statusLocation.wired && this.send([null, null, { payload: { status: 'error', error } }]);
      });

      this.mp4frag.on('reset', () => {
        if (this.resWaitingForSegments.size > 0) {
          this.resWaitingForSegments.forEach(res => {
            if (res.writableEnded === false || res.finished === false) {
              res.end();
            }
          });
        }

        const item = Mp4fragNode.basePathMap.get(this.basePath);

        item.running = false;
      });
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
              // const startIndex = data.buffered === true ? 0 : -1;

              const lastIndex = this.mp4frag.getSegmentObjectLastIndex(1);

              if (lastIndex > -1) {
                const { segmentObjects, sequence, timestamp } = this.mp4frag;

                let duration = 0;

                const segments = [];

                segmentObjects.slice(lastIndex).forEach(segmentObject => {
                  segments.push(segmentObject.segment);

                  duration += segmentObject.duration;
                });

                const segment = segments.length === 1 ? segments[0] : Buffer.concat(segments);

                socket.emit('segment', { segment, duration, timestamp, sequence });

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
      const sockets = this.ioServerOfNamespace.sockets instanceof Map ? this.ioServerOfNamespace.sockets : Object.values(this.ioServerOfNamespace.sockets);

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
      if (typeof Mp4fragNode.httpRouter === 'undefined') {
        Mp4fragNode.httpRouter = Router({ caseSensitive: true });

        Mp4fragNode.httpRouter.mp4fragRouter = true;

        Mp4fragNode.httpRouter.use((req, res, next) => {
          res.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');

          res.set('Expires', '-1');

          res.set('Pragma', 'no-cache');

          // overwrite X-Powered-By Express header
          res.set('X-Powered-By', `${packageName} ${packageVersion}`);

          // note: X-Powered-By can be only removed from Router in middleware calling res.removeHeader('X-Powered-By');

          next();
        });

        if (Mp4fragNode.httpMiddleware !== null) {
          Mp4fragNode.httpRouter.use(Mp4fragNode.httpMiddleware);
        }

        Mp4fragNode.httpRouter.get('/', (req, res) => {
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

        httpNode.use('/mp4frag', Mp4fragNode.httpRouter);
      }

      this.resWaitingForSegments = new Set();

      const httpRouter = Router({ caseSensitive: true });

      httpRouter.get('/', (req, res) => {
        res.type('json');

        res.send(
          JSON.stringify(
            { payload: this.payload, mp4frag: this.mp4frag },
            (key, value) => {
              if (value && value.type === 'Buffer') {
                return `<Buffer ${value.data.length}>`;
              }

              if (key === 'm3u8' && typeof value === 'string') {
                return value.split('\n').slice(0, -1);
              }

              return value;
            },
            2
          )
        );
      });

      httpRouter.get('/video.mp4', (req, res) => {
        res.set('Accept-Ranges', 'none');

        if (/^bytes=\d+-\d+$/.test(req.headers.range) === false) {
          if (typeof this.mp4frag === 'object') {
            const { initialization } = this.mp4frag;

            if (initialization) {
              res.type('mp4');

              res.write(initialization);

              const preBuffer = (val => {
                val = parseInt(val);
                return isNaN(val) || val < 1 ? 1 : val > 10 ? 10 : val;
              })(req.query.preBuffer);

              const lastIndex = this.mp4frag.getSegmentObjectLastIndex(preBuffer);

              if (lastIndex > -1) {
                const { segmentObjects } = this.mp4frag;

                segmentObjects.slice(lastIndex).forEach(segmentObject => {
                  res.write(segmentObject.segment);
                });
              }

              res.flush();

              this.resWaitingForSegments.add(res);

              return res.once('close', () => {
                this.resWaitingForSegments instanceof Set && this.resWaitingForSegments.delete(res);

                res.end();
              });
            }

            return res.status(404).send(_('mp4frag.error.initialization_not_found', { basePath: this.basePath }));
          }

          return res.status(404).send(_('mp4frag.error.mp4frag_not_found', { basePath: this.basePath }));
        }

        res.status(416).send(_('mp4frag.error.byte_range_requests_not_supported', { basePath: this.basePath }));
      });

      httpRouter.get('/hls.m3u8:isTxt(.txt)?', (req, res) => {
        if (typeof this.mp4frag === 'object') {
          const { m3u8 } = this.mp4frag;

          if (m3u8) {
            const { isTxt } = req.params;

            res.type(isTxt ? 'txt' : 'm3u8');

            return res.send(m3u8);
          }

          return res.status(404).send(_('mp4frag.error.m3u8_not_found', { basePath: this.basePath }));
        }

        res.status(404).send(_('mp4frag.error.mp4frag_not_found', { basePath: this.basePath }));
      });

      httpRouter.get('/init-hls.mp4', (req, res) => {
        if (typeof this.mp4frag === 'object') {
          const { initialization } = this.mp4frag;

          if (initialization) {
            res.type('mp4');

            return res.send(initialization);
          }

          return res.status(404).send(_('mp4frag.error.initialization_not_found', { basePath: this.basePath }));
        }

        res.status(404).send(_('mp4frag.error.mp4frag_not_found', { basePath: this.basePath }));
      });

      httpRouter.get('/hls:sequence([0-9]+).m4s', (req, res) => {
        if (typeof this.mp4frag === 'object') {
          const { sequence } = req.params;

          const segmentObject = this.mp4frag.getSegmentObject(sequence);

          if (segmentObject) {
            // res.type('m4s'); <-- not yet supported, filed issue https://github.com/jshttp/mime-db/issues/216

            // res.type('mp4');

            res.set('Content-Type', 'video/iso.segment');

            return res.send(segmentObject.segment);
          }

          return res.status(404).send(_('mp4frag.error.segment_not_found', { sequence, basePath: this.basePath }));
        }

        res.status(404).send(_('mp4frag.error.mp4frag_not_found', { basePath: this.basePath }));
      });

      httpRouter.basePath = this.basePath;

      Mp4fragNode.httpRouter.use(`/${this.basePath}`, httpRouter);
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

      const { stack } = Mp4fragNode.httpRouter;

      for (let i = stack.length - 1; i >= 0; --i) {
        const layer = stack[i];

        if (layer.name === 'router' && layer.handle.basePath === this.basePath) {
          stack.splice(i, 1);

          break;
        }
      }
    }

    async reset() {
      await this.stopWriting();

      this.mp4frag.resetCache();

      this.payload = '';

      this.send({ /* topic: 'set_source', */ payload: this.payload });

      this.statusLocation.displayed && this.status({ fill: 'green', shape: 'ring', text: _('mp4frag.info.reset') });

      this.statusLocation.wired && this.send([null, null, { payload: { status: 'reset' } }]);
    }

    async destroy() {
      this.removeListener('input', this.onInput);

      this.removeListener('close', this.onClose);

      await this.stopWriting();

      this.destroyHttpRoute();

      this.destroyIoServer();

      this.destroyMp4frag();

      this.destroyPaths();

      this.payload = '';

      this.send({ /* topic: 'set_source', */ payload: this.payload });
    }

    startWriting(preBuffer, timeLimit, repeated) {
      const { initialization } = this.mp4frag;

      if (initialization === null) {
        // todo temp set autoStart to true if called before starting
        // this.statusLocation.displayed && this.status({ fill: 'yellow', shape: 'dot', text: _('mp4frag.warning.not_initialized') });

        // this.statusLocation.wired && this.send([null, null, { payload: { status: 'warning', error} }]);

        return;
      }

      repeated = typeof repeated === 'boolean' ? repeated : this.repeated;

      timeLimit = Mp4fragNode.getInt(-1, Number.MAX_SAFE_INTEGER, this.timeLimit, timeLimit);

      preBuffer = Mp4fragNode.getInt(1, 5, this.preBuffer, preBuffer);

      const writeMode = timeLimit === -1 ? 'unlimited' : repeated ? 'continuous' : 'single';

      if (this.writing === true) {
        if (writeMode === 'single' && this.writeMode === 'single') {
          this.endTime = Date.now() + timeLimit;
        }
        return;
      }

      const filename = Mp4fragNode.filenameFunc({ basePath: this.basePath });

      this.send([null, { topic: this.topic.buffer.init, retain: true, writeMode, payload: initialization, filename, action: { command: 'start' } }]);

      const lastIndex = this.mp4frag.getSegmentObjectLastIndex(preBuffer);

      if (lastIndex > -1) {
        const { segmentObjects, sequence, timestamp } = this.mp4frag;

        let duration = 0;

        const segments = [];

        segmentObjects.slice(lastIndex).forEach(segmentObject => {
          segments.push(segmentObject.segment);

          duration += segmentObject.duration;
        });

        const topic = this.topic.buffer.pre;

        const retain = false;

        const payload = segments.length === 1 ? segments[0] : Buffer.concat(segments);

        this.send([null, { topic, retain, writeMode, payload, filename, duration, timestamp, sequence }]);
      }

      const topic = this.topic.buffer.seg;

      const retain = false;

      switch (writeMode) {
        case 'unlimited':
          {
            this.mp4fragWriter = (segment, sequence, duration, timestamp) => {
              this.send([null, { topic, retain, writeMode, payload: segment, filename, sequence, duration, timestamp }]);
            };
          }
          break;

        case 'single':
          {
            this.endTime = Date.now() + timeLimit;

            this.mp4fragWriter = async (segment, sequence, duration, timestamp) => {
              this.send([null, { topic, retain, writeMode, payload: segment, filename, sequence, duration, timestamp }]);

              if (Date.now() >= this.endTime) {
                await this.stopWriting();
              }
            };
          }
          break;

        case 'continuous':
          {
            const endTime = Date.now() + timeLimit;

            this.mp4fragWriter = async (segment, sequence, duration, timestamp) => {
              this.send([null, { topic, retain, writeMode, payload: segment, filename, sequence, duration, timestamp }]);

              if (Date.now() >= endTime) {
                await this.stopWriting();

                this.startWriting(preBuffer, timeLimit, repeated);
              }
            };
          }
          break;
      }

      this.writing = true;

      this.writeMode = writeMode;

      this.filename = filename;
    }

    async stopWriting() {
      if (this.writing !== true) {
        return;
      }

      const { filename } = this;

      this.filename = undefined;

      this.writeMode = undefined;

      this.mp4fragWriter = undefined;

      this.endTime = undefined;

      await sleep(200);

      this.send([null, { topic: this.topic.buffer.init, retain: true, payload: Buffer.allocUnsafe(0), filename }]);

      await sleep(100);

      this.writing = false;
    }

    async onInput(msg) {
      const { payload, action } = msg;

      if (Buffer.isBuffer(payload)) {
        if (payload.length) {
          this.mp4frag.write(payload);
        } else {
          // zero length buffer

          await this.reset();
        }

        return;
      }

      if (typeof action === 'object') {
        const { subject, command, preBuffer, timeLimit, repeated } = action;

        if (subject === 'write') {
          switch (command) {
            case 'start':
              this.startWriting(preBuffer, timeLimit, repeated);

              break;

            case 'restart':
              await this.stopWriting();

              this.startWriting(preBuffer, timeLimit, repeated);

              break;
            case 'stop':

            default:
              await this.stopWriting();
          }
        }

        return;
      }

      const { code, signal } = payload;

      // current method for resetting cache, grab exit code or signal from exec
      if (typeof code !== 'undefined' || typeof signal !== 'undefined') {
        await this.reset();

        return;
      }
    }

    async onClose(removed, done) {
      await this.destroy();

      if (removed) {
        this.statusLocation.displayed && this.status({ fill: 'grey', shape: 'ring', text: _('mp4frag.info.removed') });

        this.statusLocation.wired && this.send([null, null, { payload: { status: 'remove' } }]);
      } else {
        this.statusLocation.displayed && this.status({ fill: 'grey', shape: 'dot', text: _('mp4frag.info.closed') });

        this.statusLocation.wired && this.send([null, null, { payload: { status: 'closed' } }]);
      }

      done();
    }

    static getStatusLocation(location) {
      switch (location) {
        case 'none':
          return {};

        case 'wired':
          return { wired: true };

        case 'both':
          return { displayed: true, wired: true };

        case 'displayed':

        default:
          return { displayed: true };
      }
    }

    static getInt(min, max, def, val) {
      const int = Number.parseInt(val);

      if (Number.isNaN(int)) {
        return def;
      } else if (int < min) {
        return min;
      } else if (int > max) {
        return max;
      } else {
        return int;
      }
    }

    static getFilenameFunc(filenameFunc) {
      try {
        if (typeof filenameFunc !== 'undefined' && typeof filenameFunc({ basePath: 'test' }) === 'string') {
          return filenameFunc;
        }
      } catch (err) {
        error(_('mp4frag.error.filenameFunc', { error: err.toString() }));
      }
      return args => `mp4frag/${args.basePath}/${Date.now()}.mp4`;
    }
  }

  if (typeof settings.mp4frag !== 'object') {
    settings.mp4frag = {};
  }

  const { mp4frag } = settings;

  mp4frag.autoStart = typeof mp4frag.autoStart === 'boolean' ? mp4frag.autoStart : false;

  mp4frag.repeated = typeof mp4frag.repeated === 'boolean' ? mp4frag.repeated : false;

  mp4frag.timeLimit = Mp4fragNode.getInt(-1, Number.MAX_SAFE_INTEGER, 10000, mp4frag.timeLimit);

  mp4frag.preBuffer = Mp4fragNode.getInt(1, 5, 1, mp4frag.preBuffer);

  mp4frag.filenameFunc = Mp4fragNode.getFilenameFunc(mp4frag.filenameFunc);

  const { httpMiddleware = null, ioMiddleware = null, autoStart, repeated, timeLimit, preBuffer, filenameFunc } = mp4frag;

  Mp4fragNode.basePathRegex = /^[a-z0-9_.]{1,50}$/i;

  Mp4fragNode.basePathMap = new Map();

  Mp4fragNode.ioPath = '/mp4frag/socket.io';

  Mp4fragNode.ioServer = undefined;

  Mp4fragNode.ioMiddleware = ioMiddleware;

  Mp4fragNode.httpMiddleware = httpMiddleware;

  Mp4fragNode.httpRouter = undefined;

  Mp4fragNode.repeated = repeated;

  Mp4fragNode.timeLimit = timeLimit;

  Mp4fragNode.preBuffer = preBuffer;

  Mp4fragNode.filenameFunc = filenameFunc;

  Mp4fragNode.type = 'mp4frag';

  const Mp4fragSettings = {
    settings: {
      mp4frag: {
        value: {
          autoStart,
          preBuffer,
          repeated,
          timeLimit,
        },
        exportable: true,
      },
    },
  };

  registerType(Mp4fragNode.type, Mp4fragNode, Mp4fragSettings);
};

Mp4Frag.prototype.toJSON = function () {
  return {
    hlsPlaylistBase: this._hlsPlaylistBase,
    hlsPlaylistInit: this._hlsPlaylistInit,
    hlsPlaylistSize: this._hlsPlaylistSize,
    hlsPlaylistExtra: this._hlsPlaylistExtra,
    segmentCount: this._segmentCount,
    initialization: this.initialization,
    videoCodec: this.videoCodec,
    audioCodec: this.audioCodec,
    mime: this.mime,
    m3u8: this.m3u8,
    segmentObject: this.segmentObject,
    segmentObjects: this.segmentObjects,
  };
};

Mp4Frag.prototype.getSegmentObjectLastIndex = function (limit) {
  let lastIndex = -1;

  if (this._segmentObjects && this._segmentObjects.length) {
    let count = 0;

    for (let i = this._segmentObjects.length - 1; i >= 0 && count < limit; --i) {
      if (this._allKeyframes || this._segmentObjects[i].keyframe > -1) {
        lastIndex = i;

        ++count;
      }
    }
  }

  return lastIndex;
};
