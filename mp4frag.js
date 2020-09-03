'use strict';

const Mp4Frag = require('mp4frag');

// format data for context data menu
Mp4Frag.prototype.toString = function () {
  return `Mp4Frag({ hlsBase: '${this._hlsBase}', hlsListSize: ${this._hlsListSize} })`;
};

module.exports = RED => {
  // sets context and returns a function to unset context
  const setContext = (node, contextAccess, uniqueName, mp4frag) => {
    switch (contextAccess) {
      case 'global':
        const globalContext = node.context().global;

        globalContext.set(uniqueName, mp4frag);

        return () => {
          globalContext.set(uniqueName, undefined);
        };

      case 'flow':
        const flowContext = node.context().flow;

        flowContext.set(uniqueName, mp4frag);

        return () => {
          flowContext.set(uniqueName, undefined);
        };

      default:
        return () => {};
    }
  };

  const addRoutes = (httpRoutes, uniqueName, mp4frag) => {
    if (httpRoutes === true) {
      // define routes early
      const playlistPath = `/${uniqueName}.m3u8`;

      const playlistTxtPath = `/${uniqueName}.m3u8.txt`;

      const initFragPath = `/init-${uniqueName}.mp4`;

      const segmentPath = `/${uniqueName}:seq(\\d+).m4s`;

      console.log({
        playlistPath,
        playlistTxtPath,
        initFragPath,
        segmentPath,
      });

      RED.httpNode.get(playlistPath, (req, res) => {
        const m3u8 = mp4frag && mp4frag.m3u8;

        if (!m3u8) {
          return res.status(404).send('m3u8 playlist not found');
        }

        res.set('content-type', 'application/vnd.apple.mpegurl');

        res.send(m3u8);
      });

      RED.httpNode.get(playlistTxtPath, (req, res) => {
        const m3u8 = mp4frag && mp4frag.m3u8;

        if (!m3u8) {
          return res.status(404).send('m3u8 playlist not found');
        }

        res.set('content-type', 'text/plain');

        res.send(m3u8);
      });

      RED.httpNode.get(initFragPath, (req, res) => {
        const initialization = mp4frag && mp4frag.initialization;

        if (!initialization) {
          return res.status(404).send('initialization fragment not found');
        }

        res.set('content-type', 'video/mp4');

        res.send(initialization);
      });

      RED.httpNode.get(segmentPath, (req, res) => {
        const { seq } = req.params;

        const segment = mp4frag && mp4frag.getHlsSegment(seq);

        if (!segment) {
          return res.status(404).send(`segment ${seq} not found`);
        }

        res.set('content-type', 'video/mp4');

        res.send(segment);
      });
    }
  };

  function Mp4FragNode(config) {
    RED.nodes.createNode(this, config);

    const { uniqueName, hlsListSize, contextAccess, httpRoutes } = config;

    try {
      // mp4frag can throw if given bad hlsBase
      const mp4frag = new Mp4Frag({ hlsBase: uniqueName, hlsListSize, hlsListInit: true });

      const unsetContext = setContext(this, contextAccess, uniqueName, mp4frag);

      // do we need to remove routes ?
      addRoutes(httpRoutes, uniqueName, mp4frag);

      const onInitialized = data => {
        // todo this.send({cmd: 'start', type: 'hls', payload: '/uri_to_playlist.m3u8'});
        // todo cmd 'start' to trigger front end video playback to start
        // todo pass uri to playlist.m3u8

        // todo do we need to send full url?
        // todo refine this message to coordinate with front end video player
        this.send({ topic: 'set_source', payload: `/${uniqueName}.m3u8` });

        this.status({ fill: 'green', shape: 'dot', text: 'initialized' });
      };

      const onSegment = segment => {
        this.status({ fill: 'green', shape: 'dot', text: `segment ${mp4frag.sequence}` });
      };

      const onError = err => {
        this.status({ fill: 'red', shape: 'dot', text: err });

        this.error(err);
      };

      const onInput = msg => {
        const { payload } = msg;

        if (Buffer.isBuffer(payload) === true) {
          mp4frag.write(payload);
        } else {
          // receiving anything else will signal us to clear mp4frag cache
          // todo maybe handle input msgs

          mp4frag.resetCache();

          this.send({ topic: 'set_source', payload: '' });

          this.status({ fill: 'green', shape: 'ring', text: 'ready' });

          // todo this.send({cmd:'stop') to trigger front end video playback to stop
        }
      };

      const onClose = (removed, done) => {
        unsetContext();

        mp4frag.resetCache();

        this.send({ topic: 'set_source', payload: '' });

        if (removed) {
          mp4frag.off('initialized', onInitialized);

          mp4frag.off('segment', onSegment);

          mp4frag.off('error', onError);

          this.off('input', onInput);

          this.off('close', onClose);

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
      this.status({ fill: 'red', shape: 'dot', text: err.toString() });

      this.error(err);
    }
  }

  RED.nodes.registerType('mp4frag', Mp4FragNode);
};
