'use strict';

const Io = (() => {
  try {
    return require('socket.io');
  } catch (error) {
    return false;
  }
})();

const { Router } = require('express');

const { randomBytes } = require('crypto');

const Mp4Frag = require('mp4frag');

const { name: xPoweredByName, version: xPoweredByVersion } = require(require.resolve('mp4frag/package.json'));

module.exports = RED => {
  const {
    httpNode,
    server,
    settings: { httpNodeRoot, mp4frag: mp4fragSettings },
    _,
    nodes: { createNode, registerType },
  } = RED;

  const { httpMiddleware = null, ioMiddleware = null } = typeof mp4fragSettings === 'object' && mp4fragSettings !== null ? mp4fragSettings : {};

  class Mp4fragNode {
    constructor(config) {
      createNode(this, config);

      this.basePath = config.basePath === 'id' ? this.id : config.basePath;

      this.serveHttp = config.serveHttp !== 'false';

      this.serveIo = Io && config.serveIo !== 'false';

      this.hlsPlaylistSize = Mp4fragNode.getInt(2, 20, 4, config.hlsPlaylistSize);

      this.hlsPlaylistExtra = Mp4fragNode.getInt(0, 10, 0, config.hlsPlaylistExtra);

      this.autoStart = config.autoStart === 'true';

      this.repeated = config.repeated === 'true';

      this.timeLimit = Mp4fragNode.getInt(-1, Number.MAX_SAFE_INTEGER, 10, config.timeLimit);

      this.preBuffer = Mp4fragNode.getInt(0, 5, 1, config.preBuffer);

      this.statusData = ['playlist', 'all'].includes(config.statusData) ? config.statusData : 'playlist';

      this.playlist = '';

      this.writing = false;

      this.displayedStatus = { http: 'off', io: 'off', buffer: 'off', fill: 'yellow' };

      this.updateDisplayedStatus();

      try {
        this.createPaths(); // throws

        this.createMp4frag(); // throws

        this.createHttpRoute();

        this.createIoServer();

        this.on('input', this.onInput);

        this.on('close', this.onClose);
      } catch (error) {
        this.error(error);

        this.status({ fill: 'red', shape: 'dot', text: error.toString() });
      }
    }

    updateDisplayedStatus() {
      const { fill, http, io, buffer } = this.displayedStatus;

      this.status({ fill, shape: 'dot', text: _('mp4frag.info.status', { http, io, buffer }) });
    }

    createPaths() {
      if (this.id !== this.basePath && Mp4fragNode.basePathRegex.test(this.basePath) === false) {
        throw new Error(_('mp4frag.error.base_path_invalid', { basePath: this.basePath }));
      }

      const item = Mp4fragNode.basePathMap.get(this.basePath);

      if (typeof item === 'object' && item.id !== this.id) {
        throw new Error(_('mp4frag.error.base_path_duplicate', { basePath: this.basePath }));
      }

      Mp4fragNode.basePathMap.set(this.basePath, { id: this.id, running: false, serveHttp: false, serveIo: false });

      this.topic = {
        status: `mp4frag/${this.basePath}/status`,
        buffer: {
          init: `mp4frag/${this.basePath}/buffer/init`,
          pre: `mp4frag/${this.basePath}/buffer/pre`,
          seg: `mp4frag/${this.basePath}/buffer/seg`,
        },
      };
    }

    destroyPaths() {
      Mp4fragNode.basePathMap.delete(this.basePath);

      this.topic = undefined;
    }

    createMp4frag() {
      const mp4fragConfig = this.serveHttp
        ? { hlsPlaylistBase: 'hls', hlsPlaylistSize: this.hlsPlaylistSize, hlsPlaylistExtra: this.hlsPlaylistExtra, hlsPlaylistInit: true }
        : { segmentCount: this.hlsPlaylistSize + this.hlsPlaylistExtra };

      this.mp4frag = new Mp4Frag(mp4fragConfig);

      this.mp4frag.on('initialized', data => {
        const { mime } = data;

        const { videoCodec, audioCodec } = this.mp4frag;

        this.statusData === 'all' && this.send({ _msgid: this._msgid, topic: this.topic.status, status: 'initialized', payload: { mime, videoCodec, audioCodec } });

        const item = Mp4fragNode.basePathMap.get(this.basePath);

        item.running = true;

        this.mp4frag.prependOnceListener('segment', data => {
          if (this.serveHttp || this.serveIo) {
            this.playlist = {
              hlsPlaylist: this.hlsPlaylistPath,

              mp4Video: this.mp4VideoPath,

              socketIo: this.socketIoClient,
            };

            this.send({ _msgid: this._msgid, topic: this.topic.status, status: 'playlist', payload: this.playlist });
          }

          if (this.autoStart === true) {
            this.startWriting(0, this.timeLimit, this.repeated);
          }

          this.displayedStatus.fill = 'green';

          this.updateDisplayedStatus();
        });
      });

      this.mp4frag.on('segment', data => {
        const { segment, sequence, duration, keyframe, timestamp } = data;

        // trigger time range error
        /* if (sequence % 50 === 0) {
          return;
        }*/

        // todo move to its own mp4frag 'segment' listener in createIoServer()
        if (this.ioSocketWaitingForSegments && this.ioSocketWaitingForSegments.size > 0) {
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

        if (this.resWaitingForSegments && this.resWaitingForSegments.size > 0) {
          this.resWaitingForSegments.forEach(res => {
            if (res.writableEnded === false || res.finished === false) {
              res.write(segment);

              // res.flush();
            }
          });
        }

        if (this.writing && this.mp4fragWriter) {
          this.mp4fragWriter(segment, sequence, duration, timestamp);
        }

        const { byteLength } = segment;

        const { totalDuration, totalByteLength } = this.mp4frag;

        this.statusData === 'all' &&
          this.send({ _msgid: this._msgid, topic: this.topic.status, status: 'segment', payload: { sequence, duration, byteLength, keyframe, totalDuration, totalByteLength } });
      });

      this.mp4frag.on('error', error => {
        this.stopWriting();

        this.mp4frag.resetCache();

        this.error(error);

        this.status({ fill: 'red', shape: 'dot', text: error.toString() });
      });

      this.mp4frag.on('reset', () => {
        if (this.resWaitingForSegments && this.resWaitingForSegments.size > 0) {
          this.resWaitingForSegments.forEach(res => {
            if (res.writableEnded === false || res.finished === false) {
              res.end();
            }
          });
        }

        const item = Mp4fragNode.basePathMap.get(this.basePath);

        item.running = false;

        if (this.playlist) {
          /* if (this.socketIoClient) {

            // todo also have to terminate all sockets so that they can use new ioKey

            this.ioKey = randomBytes(15).toString('hex');

            this.socketIoClient.key = this.ioKey;

          }*/

          this.playlist = '';

          this.send({ _msgid: this._msgid, topic: this.topic.status, status: 'reset', payload: this.playlist });
        }

        this.displayedStatus.fill = 'yellow';

        this.updateDisplayedStatus();
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
      if (this.serveIo) {
        if (typeof Mp4fragNode.ioServer === 'undefined') {
          Mp4fragNode.ioPath = `${httpNodeRoot}mp4frag/socket.io`;

          Mp4fragNode.ioServer = Io(server, {
            path: Mp4fragNode.ioPath,

            transports: ['websocket' /* , 'polling'*/],
          });
        }

        this.ioNamespace = `/${this.basePath}`;

        this.ioKey = randomBytes(15).toString('hex');

        this.socketIoClient = { path: Mp4fragNode.ioPath, namespace: this.ioNamespace, key: this.ioKey };

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

        const item = Mp4fragNode.basePathMap.get(this.basePath);

        item.serveIo = true;

        this.displayedStatus.io = 'on';

        this.updateDisplayedStatus();
      }
    }

    destroyIoServer() {
      if (this.serveIo) {
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

        this.socketIoClient = undefined;

        if (Mp4fragNode.ioServer._nsps instanceof Map) {
          Mp4fragNode.ioServer._nsps.delete(this.ioNamespace);
        } else {
          Mp4fragNode.ioServer.nsps[this.ioNamespace] = undefined;
        }

        this.ioNamespace = undefined;

        this.displayedStatus.io = 'off';

        this.updateDisplayedStatus();
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
          res.set('X-Powered-By', Mp4fragNode.xPoweredBy);

          // note: X-Powered-By can be only removed from Router in middleware calling res.removeHeader('X-Powered-By');

          next();
        });

        if (Mp4fragNode.httpMiddleware !== null) {
          Mp4fragNode.httpRouter.use(Mp4fragNode.httpMiddleware);
        }

        Mp4fragNode.httpRouter.get('/', (req, res) => {
          let basePathArray = Array.from(Mp4fragNode.basePathMap);

          res.type('json').send(JSON.stringify(basePathArray, null, 2));
        });

        httpNode.use('/mp4frag', Mp4fragNode.httpRouter);
      }

      const httpRouter = Router({ caseSensitive: true });

      httpRouter.get('/', (req, res) => {
        res.type('json');

        res.send(
          JSON.stringify(
            { playlist: this.playlist, serveHttp: this.serveHttp, serveIo: this.serveIo, mp4frag: this.mp4frag },
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

      httpRouter.basePath = this.basePath;

      Mp4fragNode.httpRouter.use(`/${this.basePath}`, httpRouter);

      if (this.serveHttp) {
        this.hlsPlaylistPath = `${httpNodeRoot}mp4frag/${this.basePath}/hls.m3u8`;

        this.mp4VideoPath = `${httpNodeRoot}mp4frag/${this.basePath}/video.mp4`;

        this.resWaitingForSegments = new Set();

        httpRouter.get('/video.mp4', (req, res) => {
          res.set('Accept-Ranges', 'none');

          if (/^bytes=\d+-\d+$/.test(req.headers.range) === false) {
            if (typeof this.mp4frag === 'object') {
              const { initialization } = this.mp4frag;

              if (initialization) {
                res.type('mp4');

                res.write(initialization);

                const preBuffer = Mp4fragNode.getInt(0, 5, 1, req.query.preBuffer);

                if (preBuffer > 0) {
                  const lastIndex = this.mp4frag.getSegmentObjectLastIndex(preBuffer);

                  if (lastIndex > -1) {
                    const { segmentObjects } = this.mp4frag;

                    segmentObjects.slice(lastIndex).forEach(segmentObject => {
                      res.write(segmentObject.segment);
                    });
                  }
                }

                // res.flush();

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

        const item = Mp4fragNode.basePathMap.get(this.basePath);

        item.serveHttp = true;

        this.displayedStatus.http = 'on';

        this.updateDisplayedStatus();
      }
    }

    destroyHttpRoute() {
      if (this.serveHttp) {
        if (this.resWaitingForSegments.size > 0) {
          this.resWaitingForSegments.forEach(res => {
            if (res.writableEnded === false || res.finished === false) {
              res.end();
            }
          });

          this.resWaitingForSegments.clear();
        }

        this.hlsPlaylistPath = undefined;

        this.mp4VideoPath = undefined;

        this.resWaitingForSegments = undefined;

        this.displayedStatus.http = 'off';

        this.updateDisplayedStatus();
      }

      const { stack } = Mp4fragNode.httpRouter;

      for (let i = stack.length - 1; i >= 0; --i) {
        const layer = stack[i];

        if (layer.name === 'router' && layer.handle.basePath === this.basePath) {
          stack.splice(i, 1);

          break;
        }
      }
    }

    reset() {
      this.stopWriting();

      this.mp4frag.resetCache();
    }

    destroy() {
      this.removeListener('input', this.onInput);

      this.removeListener('close', this.onClose);

      this.stopWriting();

      this.destroyHttpRoute();

      this.destroyIoServer();

      this.destroyMp4frag();

      this.destroyPaths();
    }

    startWriting(preBuffer, timeLimit, repeated) {
      const { initialization, duration } = this.mp4frag;

      if (initialization === null) {
        // todo temp set autoStart to true if called before initialized

        this.warn(_('mp4frag.warning.not_initialized'));

        return;
      }

      repeated = typeof repeated === 'boolean' ? repeated : this.repeated;

      timeLimit = Mp4fragNode.getInt(-1, Number.MAX_SAFE_INTEGER, this.timeLimit, timeLimit);

      preBuffer = Mp4fragNode.getInt(0, 5, this.preBuffer, preBuffer);

      const writeMode = timeLimit === -1 ? 'unlimited' : repeated ? 'continuous' : 'single';

      if (this.writing === true) {
        if (writeMode === 'single' && this.writeMode === 'single') {
          this.endTime = Date.now() + timeLimit;
        }
        return;
      }

      this.send([null, { _msgid: this._msgid, topic: this.topic.buffer.init, retain: true, payload: initialization, duration }]);

      if (preBuffer > 0) {
        const lastIndex = this.mp4frag.getSegmentObjectLastIndex(preBuffer);

        if (lastIndex > -1) {
          const { segmentObjects } = this.mp4frag;

          const topic = this.topic.buffer.pre;

          const retain = false;

          segmentObjects.slice(lastIndex).forEach(segmentObject => {
            const { segment: payload, duration, timestamp, sequence } = segmentObject;

            this.send([null, { _msgid: this._msgid, topic, retain, payload, duration, timestamp, sequence }]);
          });
        }
      }

      const topic = this.topic.buffer.seg;

      const retain = false;

      switch (writeMode) {
        case 'unlimited':
          {
            this.mp4fragWriter = (segment, sequence, duration, timestamp) => {
              this.send([null, { _msgid: this._msgid, topic, retain, payload: segment, sequence, duration, timestamp }]);
            };
          }
          break;

        case 'single':
          {
            this.endTime = Date.now() + timeLimit;

            this.mp4fragWriter = (segment, sequence, duration, timestamp) => {
              this.send([null, { _msgid: this._msgid, topic, retain, payload: segment, sequence, duration, timestamp }]);

              if (Date.now() >= this.endTime) {
                this.stopWriting();
              }
            };
          }
          break;

        case 'continuous':
          {
            const endTime = Date.now() + timeLimit;

            this.mp4fragWriter = (segment, sequence, duration, timestamp) => {
              this.send([null, { _msgid: this._msgid, topic, retain, payload: segment, sequence, duration, timestamp }]);

              if (Date.now() >= endTime) {
                this.stopWriting();

                this.startWriting(preBuffer, timeLimit, repeated);
              }
            };
          }
          break;
      }

      this.writeMode = writeMode;

      this.writing = true;

      this.displayedStatus.buffer = 'on';

      this.updateDisplayedStatus();
    }

    stopWriting() {
      if (this.writing !== true) {
        return;
      }

      this.writeMode = undefined;

      this.mp4fragWriter = undefined;

      this.endTime = undefined;

      this.send([null, { _msgid: this._msgid, topic: this.topic.buffer.init, retain: true, payload: Buffer.allocUnsafe(0) }]);

      this.writing = false;

      this.displayedStatus.buffer = 'off';

      this.updateDisplayedStatus();
    }

    onInput(msg, send, done) {
      this._msgid = msg._msgid;

      // this.lastSend = send;

      // this.lastMsg = msg;

      this.handleMsg(msg);

      done();
    }

    handleMsg(msg) {
      const { payload, action } = msg;

      if (Buffer.isBuffer(payload)) {
        if (payload.length) {
          this.mp4frag.write(payload);
        } else {
          // zero length buffer

          this.reset();
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
              this.stopWriting();

              this.startWriting(preBuffer, timeLimit, repeated);

              break;
            case 'stop':

            default:
              this.stopWriting();
          }
        }

        return;
      }

      const { code, signal } = payload;

      // current method for resetting cache, grab exit code or signal from exec
      if (typeof code !== 'undefined' || typeof signal !== 'undefined') {
        this.reset();

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

    static getInt(min, max, def, val) {
      const int = Number.parseInt(val);

      return Number.isNaN(int) ? def : int < min ? min : int > max ? max : int;
    }
  }

  Mp4fragNode.xPoweredBy = `${xPoweredByName}@${xPoweredByVersion}`;

  Mp4fragNode.basePathRegex = /^[a-z\d_.]{1,50}$/i;

  Mp4fragNode.basePathMap = new Map();

  Mp4fragNode.ioPath = undefined;

  Mp4fragNode.ioServer = undefined;

  Mp4fragNode.ioMiddleware = ioMiddleware;

  Mp4fragNode.httpMiddleware = httpMiddleware;

  Mp4fragNode.httpRouter = undefined;

  Mp4fragNode.type = 'mp4frag';

  registerType(Mp4fragNode.type, Mp4fragNode);
};

Mp4Frag.prototype.toJSON = function () {
  return {
    hlsPlaylistBase: this._hlsPlaylistBase || null,
    hlsPlaylistInit: this._hlsPlaylistInit || null,
    hlsPlaylistSize: this._hlsPlaylistSize || null,
    hlsPlaylistExtra: this._hlsPlaylistExtra || null,
    segmentCount: this._segmentCount || null,
    initialization: this.initialization,
    allKeyframes: this.allKeyframes,
    videoCodec: this.videoCodec,
    audioCodec: this.audioCodec,
    mime: this.mime,
    m3u8: this.m3u8,
    totalDuration: this.totalDuration,
    totalByteLength: this.totalByteLength,
    segmentObject: this.segmentObject,
    segmentObjects: this.segmentObjects,
  };
};

Mp4Frag.prototype.getSegmentObjectLastIndex = function (limit) {
  let lastIndex = -1;

  if (this._segmentObjects && this._segmentObjects.length) {
    let count = 0;

    for (let i = this._segmentObjects.length - 1; i >= 0 && count < limit; --i) {
      if (this._allKeyframes || this._segmentObjects[i].keyframe) {
        lastIndex = i;

        ++count;
      }
    }
  }

  return lastIndex;
};
