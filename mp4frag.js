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
    if (uniqueName) {
      if (uniqueNames.has(uniqueName)) {
        throw new Error(`${uniqueName} already in use`);
      }

      uniqueNames.add(uniqueName);

      return () => uniqueNames.delete(uniqueName);
    }

    return () => {};
  };

  // sets context and returns a function to unset context
  const setContext = (node, contextAccess, uniqueName, mp4frag) => {
    switch (contextAccess) {
      case 'global':
        const globalContext = node.context().global;

        globalContext.set(uniqueName, mp4frag);

        return () => globalContext.set(uniqueName, undefined);

      case 'flow':
        const flowContext = node.context().flow;

        flowContext.set(uniqueName, mp4frag);

        return () => flowContext.set(uniqueName, undefined);

      default:
        return () => {};
    }
  };

  // adds routes and returns a function to remove routes
  const addRoutes = (node, uniqueName, httpRoutes, routesStructure, mp4frag) => {
    if (httpRoutes === true) {
      let pattern;

      if (routesStructure === 'id_path') {
        pattern = `^\/mp4frag\/${node.id}/(?:(hls.m3u8)|hls([0-9]+).m4s|(init-hls.mp4)|(hls.m3u8.txt))$`;
      } else if (routesStructure === 'unique_path') {
        /* if (RED.validators.regex(/^(?:(?!^Change_This_Name$)[a-z_]){3,50}$/i)(uniqueName) === false) {
          throw new Error(`invalid unique name ${uniqueName}`);
        }*/
        pattern = `^\/mp4frag\/${uniqueName}/(?:(hls.m3u8)|hls([0-9]+).m4s|(init-hls.mp4)|(hls.m3u8.txt))$`;
      } else {
        throw new Error(`invalid routes structure ${routesStructure}`);
      }

      const regexp = new RegExp(pattern, 'i');

      RED.httpNode.get(regexp, (req, res) => {
        if (!mp4frag) {
          return res.status(404).send(`${uniqueName} mp4frag not found`);
        }

        const { params } = req;

        if (params[0]) {
          const { m3u8 } = mp4frag;

          if (m3u8) {
            res.set('content-type', 'application/vnd.apple.mpegurl');

            return res.send(m3u8);
          }

          return res.status(404).send(`${uniqueName} m3u8 playlist not found`);
        }

        if (params[1]) {
          const sequence = params[1];

          const segment = mp4frag.getHlsSegment(sequence);

          if (segment) {
            res.set('content-type', 'video/mp4');

            return res.send(segment);
          }

          return res.status(404).send(`${uniqueName} segment ${sequence} not found`);
        }

        if (params[2]) {
          const { initialization } = mp4frag;

          if (initialization) {
            res.set('content-type', 'video/mp4');

            return res.send(initialization);
          }

          return res.status(404).send(`${uniqueName} initialization fragment not found`);
        }

        if (params[3]) {
          const { m3u8 } = mp4frag;

          if (m3u8) {
            res.set('content-type', 'text/plain');

            return res.send(m3u8);
          }

          return res.status(404).send(`${uniqueName} m3u8 playlist not found`);
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
    }

    return () => {};
  };

  function Mp4FragNode(config) {
    RED.nodes.createNode(this, config);

    const { uniqueName, hlsListSize, contextAccess, httpRoutes, routesStructure } = config;

    try {
      // throws if unique name already exists
      const deleteUniqueName = addUniqueName(uniqueName);

      // mp4frag can throw if given bad hlsBase
      const mp4frag = new Mp4Frag({ hlsBase: 'hls', hlsListSize, hlsListInit: true });

      const unsetContext = setContext(this, contextAccess, uniqueName, mp4frag);

      // throws if uniqueName is invalid while choosing routesStructure unique_path
      const removeRoutes = addRoutes(this, uniqueName, httpRoutes, routesStructure, mp4frag);

      const playlist =
        routesStructure === 'id_path' ? `/mp4frag/${this.id}/hls.m3u8` : `/mp4frag/${uniqueName}/hls.m3u8`;

      const onInitialized = data => {
        console.log({ playlist });

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
