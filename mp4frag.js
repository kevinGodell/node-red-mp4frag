'use strict';

const Mp4Frag = require('mp4frag');

// format data for context data menu
Mp4Frag.prototype.toString = function () {
  return `Mp4Frag({ hlsBase: '${this._hlsBase}', hlsListSize: ${this._hlsListSize} })`;
};

module.exports = RED => {
  // keep track of unique names
  const uniqueNames = new Set();

  // adds unique name and returns a function to delete unique name
  const addUniqueName = uniqueName => {
    if (uniqueNames.has(uniqueName)) {
      throw new Error(`${uniqueName} already in use`);
    }

    uniqueNames.add(uniqueName);

    return () => {
      uniqueNames.delete(uniqueName);
    };
  };

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

  // adds routes and returns a function to remove routes
  const addRoutes = (httpRoutes, uniqueName, mp4frag) => {
    if (httpRoutes === true) {
      const playlistPath = `/${uniqueName}.m3u8`;

      const playlistTxtPath = `/${uniqueName}.m3u8.txt`;

      const initFragPath = `/init-${uniqueName}.mp4`;

      const segmentPath = `/${uniqueName}:seq(\\d+).m4s`;

      const paths = [playlistPath, playlistTxtPath, initFragPath, segmentPath];

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

      return () => {
        const { stack } = RED.httpNode._router;

        for (let i = stack.length - 1; i >= 0; --i) {
          const layer = stack[i];

          if (layer.route && paths.includes(layer.route.path)) {
            stack.splice(i, 1);
          }
        }
      };
    } else {
      return () => {};
    }
  };

  function Mp4FragNode(config) {
    RED.nodes.createNode(this, config);

    const { uniqueName, hlsListSize, contextAccess, httpRoutes } = config;

    try {
      // throws if unique name already exists
      const deleteUniqueName = addUniqueName(uniqueName);

      // mp4frag can throw if given bad hlsBase
      const mp4frag = new Mp4Frag({ hlsBase: uniqueName, hlsListSize, hlsListInit: true });

      const unsetContext = setContext(this, contextAccess, uniqueName, mp4frag);

      const removeRoutes = addRoutes(httpRoutes, uniqueName, mp4frag);

      const onInitialized = data => {
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
        }
      };

      const onClose = (removed, done) => {
        deleteUniqueName();

        unsetContext();

        removeRoutes();

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
      this.error(err);

      this.status({ fill: 'red', shape: 'dot', text: err.toString() });
    }
  }

  RED.nodes.registerType('mp4frag', Mp4FragNode);
};
