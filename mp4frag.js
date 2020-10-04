'use strict';

const Mp4Frag = require('mp4frag');

module.exports = RED => {
  const { _ } = RED;

  const { createNode, registerType } = RED.nodes;

  const NODE_TYPE = 'mp4frag';

  class Mp4fragNode {
    constructor(config) {
      createNode(this, config);

      this.hlsPlaylistUrl = config.hlsPlaylistUrl;

      this.hlsPlaylistSize = config.hlsPlaylistSize;

      this.hlsPlaylistExtra = config.hlsPlaylistExtra;

      try {
        this.createPlaylist(); // throws

        this.createMp4frag(); // throws

        this.createRoute();

        this.on('input', this.onInput);

        this.on('close', this.onClose);

        this.status({ fill: 'green', shape: 'ring', text: _('mp4frag.info.ready') });
      } catch (err) {
        this.error(err);

        this.status({ fill: 'red', shape: 'dot', text: err.toString() });
      }
    }

    createPlaylist() {
      if (this.id !== this.hlsPlaylistUrl && Mp4fragNode.hlsPlaylistUrlRegex.test(this.hlsPlaylistUrl) === false) {
        throw new Error(_('mp4frag.error.hls_playlist_url_invalid', { hlsPlaylistUrl: this.hlsPlaylistUrl }));
      }

      const item = Mp4fragNode.hlsPlaylistUrlMap.get(this.hlsPlaylistUrl);

      if (typeof item !== 'undefined' && item !== this.id) {
        throw new Error(_('mp4frag.error.hls_playlist_url_duplicate', { hlsPlaylistUrl: this.hlsPlaylistUrl }));
      }

      Mp4fragNode.hlsPlaylistUrlMap.set(this.hlsPlaylistUrl, this.id);

      this.hlsPlaylist = `/mp4frag/${this.hlsPlaylistUrl}/hls.m3u8`;
    }

    destroyPlaylist() {
      Mp4fragNode.hlsPlaylistUrlMap.delete(this.hlsPlaylistUrl);

      this.hlsPlaylist = undefined;
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
      };
    }

    destroyMp4frag() {
      this.mp4frag.off('initialized', this.mp4fragEvents.initialized);

      this.mp4frag.off('segment', this.mp4fragEvents.segment);

      this.mp4frag.off('error', this.mp4fragEvents.error);

      this.mp4fragEvents = undefined;

      this.mp4frag.resetCache();

      this.mp4frag = undefined;
    }

    mp4fragOn(type, func) {
      this.mp4frag.on(type, func);

      return func;
    }

    createRoute() {
      const pattern = `^\/mp4frag\/${this.hlsPlaylistUrl}/(?:(hls.m3u8)|hls([0-9]+).m4s|(init-hls.mp4)|(hls.m3u8.txt))$`;

      this.routePath = new RegExp(pattern, 'i');

      RED.httpNode.get(this.routePath, (req, res) => {
        if (typeof this.mp4frag === 'undefined') {
          return res.status(404).send(_('mp4frag.error.mp4frag_not_found', { hlsPlaylistUrl: this.hlsPlaylistUrl }));
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

          return res.status(404).send(_('mp4frag.error.m3u8_not_found', { hlsPlaylistUrl: this.hlsPlaylistUrl }));
        }

        if (params[1]) {
          const sequence = params[1];

          const segment = this.mp4frag.getSegment(sequence);

          if (segment) {
            // res.type('m4s'); <-- not yet supported, filed issue https://github.com/jshttp/mime-db/issues/216

            res.set('Content-Type', 'video/iso.segment');

            return res.send(segment);
          }

          return res.status(404).send(_('mp4frag.error.segment_not_found', { sequence, hlsPlaylistUrl: this.hlsPlaylistUrl }));
        }

        if (params[2]) {
          const { initialization } = this.mp4frag;

          if (initialization) {
            res.type('mp4');

            return res.send(initialization);
          }

          return res.status(404).send(_('mp4frag.error.initialization_not_found', { hlsPlaylistUrl: this.hlsPlaylistUrl }));
        }

        if (params[3]) {
          const { m3u8 } = this.mp4frag;

          if (m3u8) {
            res.type('txt');

            return res.send(m3u8);
          }

          return res.status(404).send(_('mp4frag.error.m3u8_not_found', { hlsPlaylistUrl: this.hlsPlaylistUrl }));
        }
      });
    }

    destroyRoute() {
      const { stack } = RED.httpNode._router;

      for (let i = stack.length - 1; i >= 0; --i) {
        const layer = stack[i];

        if (layer.route && layer.route.path === this.routePath) {
          stack.splice(i, 1);

          break;
        }
      }
    }

    onInput(msg) {
      const { payload } = msg;

      if (Buffer.isBuffer(payload) === true) {
        return this.mp4frag.write(payload);
      }

      const { code, signal } = payload;

      // current method for resetting cache
      // grab exit code or signal from exec
      // cant just check (!code) because it could be 0 ???
      if (typeof code !== 'undefined' || typeof signal !== 'undefined') {
        this.mp4frag.resetCache();

        this.send({ /* topic: 'set_source', */ payload: '' });

        return this.status({ fill: 'green', shape: 'ring', text: _('mp4frag.info.reset') });
      }

      // temporarily log unknown payload as warning for debugging
      this.warn(_('mp4frag.warning.unknown_payload', { payload }));

      this.status({ fill: 'yellow', shape: 'dot', text: _('mp4frag.warning.unknown_payload', { payload }) });
    }

    onClose(removed, done) {
      this.removeListener('input', this.onInput);

      this.removeListener('close', this.onClose);

      this.destroyRoute();

      this.destroyMp4frag();

      this.destroyPlaylist();

      this.send({ /* topic: 'set_source', */ payload: '' });

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
      const { sequence, duration } = data;

      if (sequence === 0) {
        this.send({ /* topic: 'set_source', */ payload: this.hlsPlaylist });
      }

      this.status({ fill: 'green', shape: 'dot', text: _('mp4frag.info.segment', { sequence, duration }) });
    }

    onError(err) {
      this.error(err);

      this.status({ fill: 'red', shape: 'dot', text: err.toString() });
    }
  }

  Mp4fragNode.hlsPlaylistUrlMap = new Map();

  Mp4fragNode.hlsPlaylistUrlRegex = /^[a-z0-9_.]{1,50}$/i;

  registerType(NODE_TYPE, Mp4fragNode);
};
