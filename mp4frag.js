'use strict';

const Mp4Frag = require('mp4frag');

// format data for context data menu
Mp4Frag.prototype.toString = function () {
  return `Mp4Frag({ hlsBase: '${this._hlsBase}', hlsListSize: ${this._hlsListSize} })`;
};

module.exports = RED => {
  // keep track of hlsListUrls
  const hlsListUrlMap = new Map();

  const hlsListUrlRegex = /^[a-z0-9_.]{1,50}$/i;

  const testHlsListUrl = (id, hlsListUrl) => {
    if (id !== hlsListUrl && hlsListUrlRegex.test(hlsListUrl) === false) {
      throw new Error(`hlsListUrl "${hlsListUrl}" is invalid`);
    }
  };

  // add hlsListUrl to map and return function to remove item
  const setHlsListUrl = (id, hlsListUrl) => {
    const item = hlsListUrlMap.get(hlsListUrl);

    if (typeof item !== 'undefined' && item !== id) {
      throw new Error(`hlsListUrl "${hlsListUrl}" is already in use`);
    }

    hlsListUrlMap.set(hlsListUrl, id);

    return () => hlsListUrlMap.delete(hlsListUrl);
  };

  // adds routes and returns a function to remove route
  const addRoute = (hlsListUrl, mp4frag) => {
    const pattern = `^\/mp4frag\/${hlsListUrl}/(?:(hls.m3u8)|hls([0-9]+).m4s|(init-hls.mp4)|(hls.m3u8.txt))$`;

    const regexp = new RegExp(pattern, 'i');

    RED.httpNode.get(regexp, (req, res) => {
      if (!mp4frag) {
        return res.status(404).send(`${hlsListUrl} mp4frag not found`);
      }

      const { params } = req;

      if (params[0]) {
        const { m3u8 } = mp4frag;

        if (m3u8) {
          res.set('content-type', 'application/vnd.apple.mpegurl');

          return res.send(m3u8);
        }

        return res.status(404).send(`${hlsListUrl} m3u8 playlist not found`);
      }

      if (params[1]) {
        const sequence = params[1];

        const segment = mp4frag.getSegmentNumber(sequence);

        if (segment) {
          res.set('content-type', 'video/mp4');

          return res.send(segment);
        }

        return res.status(404).send(`${hlsListUrl} segment ${sequence} not found`);
      }

      if (params[2]) {
        const { initialization } = mp4frag;

        if (initialization) {
          res.set('content-type', 'video/mp4');

          return res.send(initialization);
        }

        return res.status(404).send(`${hlsListUrl} initialization fragment not found`);
      }

      if (params[3]) {
        const { m3u8 } = mp4frag;

        if (m3u8) {
          res.set('content-type', 'text/plain');

          return res.send(m3u8);
        }

        return res.status(404).send(`${hlsListUrl} m3u8.txt playlist not found`);
      }
    });

    return () => {
      const { stack } = RED.httpNode._router;

      for (let i = stack.length - 1; i >= 0; --i) {
        const layer = stack[i];

        if (layer.route && layer.route.path === regexp) {
          stack.splice(i, 1);

          break;
        }
      }
    };
  };

  function Mp4FragNode(config) {
    RED.nodes.createNode(this, config);

    const { id, hlsListSize, hlsListExtra, hlsListUrl } = config;

    try {
      // throws if fails regex
      testHlsListUrl(id, hlsListUrl);

      // throws if using trying duplicate hlsListUrl
      const deleteHlsListUrl = setHlsListUrl(id, hlsListUrl);

      // mp4frag can throw if given bad hlsBase
      const mp4frag = new Mp4Frag({ hlsBase: 'hls', hlsListSize, hlsListExtra, hlsListInit: true });

      const removeRoute = addRoute(hlsListUrl, mp4frag);

      const playlist = `/mp4frag/${hlsListUrl}/hls.m3u8`;

      const onInitialized = data => {
        this.send({ topic: 'set_source', payload: playlist });

        this.status({ fill: 'green', shape: 'dot', text: 'initialized' });
      };

      const onSegment = segment => {
        this.status({ fill: 'green', shape: 'dot', text: `segment ${mp4frag.sequence}` });
      };

      const onError = err => {
        this.error(err);

        this.status({ fill: 'red', shape: 'dot', text: err.toString() });
      };

      const onInput = msg => {
        const { payload } = msg;

        if (Buffer.isBuffer(payload) === true) {
          return mp4frag.write(payload);
        }

        const { code, signal } = payload;

        // current method for resetting cache
        // grab exit code or signal from exec
        // cant just check (!code) because it could be 0 ???
        if (code !== undefined || signal !== undefined) {
          mp4frag.resetCache();

          this.send({ topic: 'set_source', payload: '' });

          return this.status({ fill: 'green', shape: 'ring', text: 'reset' });
        }

        // temporarily log unknown payload as error for debugging
        this.error(payload);

        this.status({ fill: 'red', shape: 'dot', text: `unknown payload ${payload}` });
      };

      const onClose = (removed, done) => {
        deleteHlsListUrl();

        removeRoute();

        mp4frag.resetCache();

        mp4frag.off('initialized', onInitialized);

        mp4frag.off('segment', onSegment);

        mp4frag.off('error', onError);

        this.off('input', onInput);

        this.off('close', onClose);

        this.send({ topic: 'set_source', payload: '' });

        if (removed) {
          this.status({ fill: 'red', shape: 'ring', text: 'removed' });
        } else {
          this.status({ fill: 'red', shape: 'dot', text: 'closed' });
        }

        done();
      };

      mp4frag.on('initialized', onInitialized);

      mp4frag.on('segment', onSegment);

      mp4frag.on('error', onError);

      this.on('input', onInput);

      this.on('close', onClose);

      this.status({ fill: 'green', shape: 'ring', text: 'ready' });
    } catch (err) {
      // mp4frag && mp4frag.resetCache();

      this.error(err);

      this.status({ fill: 'red', shape: 'dot', text: err.toString() });
    }
  }

  RED.nodes.registerType('mp4frag', Mp4FragNode);
};
