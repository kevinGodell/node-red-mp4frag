'use strict';

const Io = require('socket.io');

const { Router } = require('express');

const { randomBytes } = require('crypto');

const Mp4Frag = require('mp4frag');

const { promisify } = require('util');

const sleep = promisify(setTimeout);

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

      this.basePath = config.basePath;

      this.hlsPlaylistSize = config.hlsPlaylistSize;

      this.hlsPlaylistExtra = config.hlsPlaylistExtra;

      this.repeated = config.repeated === 'true';

      this.timeLimit = Mp4fragNode.getInt(-1, Number.MAX_SAFE_INTEGER, Mp4fragNode.timeLimit, config.timeLimit);

      this.preBuffer = Mp4fragNode.getInt(1, 5, Mp4fragNode.preBuffer, config.preBuffer);

      this.autoStart = config.autoStart === 'true';

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

              const buffer = this.mp4frag.getSegmentList(startIndex, true, 1);

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

          res.set('Accept-Ranges', 'none');

          if (!initialization) {
            return res.status(404).send(_('mp4frag.error.initialization_not_found', { basePath: this.basePath }));
          }

          if (typeof req.headers.range !== 'undefined') {
            const results = /bytes=(?<start>\d+)-(?<end>\d*)/.exec(req.headers.range);

            if (results && results.groups && results.groups.start && results.groups.end) {
              return res.status(416).send(_('mp4frag.error.byte_range_requests_not_supported', { basePath: this.basePath }));
            }
          }

          res.type('mp4');

          res.write(initialization);

          const buffer = this.mp4frag.getSegmentList(-1, true, 1);

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

          res.send(
            JSON.stringify(
              { payload: this.payload, mp4frag: this.mp4frag },
              (key, value) => {
                if (value && value.type === 'Buffer') {
                  return `<Buffer ${value.data.length}>`;
                }

                if (key === '_m3u8' && typeof value === 'string') {
                  return value.split('\n');
                }

                return value;
              },
              2
            )
          );
        }
      };

      Mp4fragNode.httpRouter.route(this.routePath).get(endpoint);
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

    async reset() {
      await this.stopWriting();

      this.mp4frag.resetCache();

      this.payload = '';

      this.send({ /* topic: 'set_source', */ payload: this.payload });

      this.status({ fill: 'green', shape: 'ring', text: _('mp4frag.info.reset') });
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

    startWriting(preBuffer, timeLimit, repeated) {
      const { initialization } = this.mp4frag;

      if (initialization === null) {
        this.status({ fill: 'yellow', shape: 'dot', text: _('mp4frag.warning.not_initialized') });
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

      const buffer = this.mp4frag.getSegmentList(-1, true, preBuffer);

      if (Buffer.isBuffer(buffer)) {
        this.send([null, { topic: this.topic.buffer.pre, retain: false, writeMode, payload: buffer, filename }]);
      }

      const topic = this.topic.buffer.seg;

      const retain = false;

      switch (writeMode) {
        case 'unlimited':
          {
            this.mp4fragWriter = segment => {
              this.send([null, { topic, retain, writeMode, payload: segment, filename }]);
            };
          }
          break;

        case 'single':
          {
            this.endTime = Date.now() + timeLimit;

            this.mp4fragWriter = segment => {
              this.send([null, { topic, retain, writeMode, payload: segment, filename }]);

              if (Date.now() >= this.endTime) {
                this.stopWriting();
              }
            };
          }
          break;

        case 'continuous':
          {
            const endTime = Date.now() + timeLimit;

            this.mp4fragWriter = async segment => {
              this.send([null, { topic, retain, writeMode, payload: segment, filename }]);

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

      this.writing = false;

      this.writeMode = undefined;

      this.mp4fragWriter = undefined;

      this.endTime = undefined;

      this.send([null, { topic: this.topic.buffer.init, retain: true, payload: Buffer.allocUnsafe(0), filename: this.filename }]);

      this.filename = undefined;

      await sleep(300);
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

      const item = Mp4fragNode.basePathMap.get(this.basePath);

      item.running = true;
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

      const item = Mp4fragNode.basePathMap.get(this.basePath);

      item.running = false;
    }

    onError(err) {
      this.stopWriting();

      this.mp4frag.resetCache();

      // this.error(err);

      this.status({ fill: 'red', shape: 'dot', text: err.toString() });
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

  mp4frag.repeated = typeof mp4frag.repeated === 'boolean' ? mp4frag.repeated : false;

  mp4frag.timeLimit = Mp4fragNode.getInt(-1, Number.MAX_SAFE_INTEGER, 10000, mp4frag.timeLimit);

  mp4frag.preBuffer = Mp4fragNode.getInt(1, 5, 1, mp4frag.preBuffer);

  mp4frag.filenameFunc = Mp4fragNode.getFilenameFunc(mp4frag.filenameFunc);

  const { httpMiddleware = null, ioMiddleware = null, repeated, timeLimit, preBuffer, filenameFunc } = mp4frag;

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
