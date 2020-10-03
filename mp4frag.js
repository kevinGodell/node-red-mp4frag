'use strict';

const Mp4Frag = require('mp4frag');

module.exports = RED => {
  const { _ } = RED;

  const { createNode, registerType } = RED.nodes;

  const NODE_TYPE = 'mp4frag';

  class Mp4fragNode {
    constructor(config) {
      createNode(this, config);

      this.hlsListUrl = config.hlsListUrl;

      this.hlsListSize = config.hlsListSize;

      this.hlsListExtra = config.hlsListExtra;

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
      if (this.id !== this.hlsListUrl && Mp4fragNode.hlsListUrlRegex.test(this.hlsListUrl) === false) {
        throw new Error(_('mp4frag.error.hls_list_url_invalid', { hlsListUrl: this.hlsListUrl }));
      }

      const item = Mp4fragNode.hlsListUrlMap.get(this.hlsListUrl);

      if (typeof item !== 'undefined' && item !== this.id) {
        throw new Error(_('mp4frag.error.hls_list_url_duplicate', { hlsListUrl: this.hlsListUrl }));
      }

      Mp4fragNode.hlsListUrlMap.set(this.hlsListUrl, this.id);

      this.playlist = `/mp4frag/${this.hlsListUrl}/hls.m3u8`;
    }

    destroyPlaylist() {
      Mp4fragNode.hlsListUrlMap.delete(this.hlsListUrl);

      this.playlist = undefined;
    }

    createMp4frag() {
      this.mp4frag = new Mp4Frag({
        hlsBase: 'hls',
        hlsListSize: this.hlsListSize,
        hlsListExtra: this.hlsListExtra,
        hlsListInit: true,
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
      const pattern = `^\/mp4frag\/${this.hlsListUrl}/(?:(hls.m3u8)|hls([0-9]+).m4s|(init-hls.mp4)|(hls.m3u8.txt))$`;

      this.routePath = new RegExp(pattern, 'i');

      RED.httpNode.get(this.routePath, (req, res) => {
        if (typeof this.mp4frag === 'undefined') {
          return res.status(404).send(_('mp4frag.error.mp4frag_not_found', { hlsListUrl: this.hlsListUrl }));
        }

        const { params } = req;

        if (params[0]) {
          const { m3u8 } = this.mp4frag;

          if (m3u8) {
            res.set('content-type', 'application/vnd.apple.mpegurl');

            return res.send(m3u8);
          }

          return res.status(404).send(_('mp4frag.error.m3u8_not_found', { hlsListUrl: this.hlsListUrl }));
        }

        if (params[1]) {
          const sequence = params[1];

          const segment = this.mp4frag.getSegment(sequence);

          if (segment) {
            res.set('content-type', 'video/mp4');

            return res.send(segment);
          }

          return res.status(404).send(_('mp4frag.error.segment_not_found', { sequence, hlsListUrl: this.hlsListUrl }));
        }

        if (params[2]) {
          const { initialization } = this.mp4frag;

          if (initialization) {
            res.set('content-type', 'video/mp4');

            return res.send(initialization);
          }

          return res.status(404).send(_('mp4frag.error.initialization_not_found', { hlsListUrl: this.hlsListUrl }));
        }

        if (params[3]) {
          const { m3u8 } = this.mp4frag;

          if (m3u8) {
            res.set('content-type', 'text/plain');

            return res.send(m3u8);
          }

          return res.status(404).send(_('mp4frag.error.m3u8_not_found', { hlsListUrl: this.hlsListUrl }));
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

        this.send({ topic: 'set_source', payload: '' });

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

      this.send({ topic: 'set_source', payload: '' });

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
        this.send({ topic: 'set_source', payload: this.playlist });
      }

      this.status({ fill: 'green', shape: 'dot', text: _('mp4frag.info.segment', { sequence, duration }) });
    }

    onError(err) {
      this.error(err);

      this.status({ fill: 'red', shape: 'dot', text: err.toString() });
    }
  }

  Mp4fragNode.hlsListUrlMap = new Map();

  Mp4fragNode.hlsListUrlRegex = /^[a-z0-9_.]{1,50}$/i;

  registerType(NODE_TYPE, Mp4fragNode);
};
