'use strict';

const Mp4Frag = require('mp4frag');

// format data for context data menu
Mp4Frag.prototype.toString = function () {
  return `Mp4Frag({ hlsBase: '${this._hlsBase}', hlsListSize: ${this._hlsListSize} })`;
};

module.exports = function (RED) {
  function Mp4FragNode (config) {
    RED.nodes.createNode(this, config);

    const {hlsBase, hlsListSize} = config;

    const globalContext = this.context().global;

    // check if hlsBase is already used by another node
    if (globalContext.get(hlsBase) !== undefined) {
      const err = `hlsBase '${hlsBase}' already in use`;

      this.status({fill: 'red', shape: 'dot', text: err});

      return this.error(err);
    }

    try {

      // mp4frag can throw if given bad hlsBase
      const mp4frag = new Mp4Frag({hlsBase, hlsListSize});

      globalContext.set(hlsBase, mp4frag);

      const onInitialized = data => {
        this.status({fill: 'green', shape: 'dot', text: 'mp4 initialized'});
      };

      const onSegment = segment => {
        this.status({fill: 'green', shape: 'dot', text: `mp4 segment ${mp4frag.sequence}`});
      };

      const onError = err => {
        this.status({fill: 'red', shape: 'dot', text: err});

        this.error(err);
      };

      const onInput = msg => {
        const {payload} = msg;

        if (Buffer.isBuffer(payload) === true) {
          return mp4frag.write(payload);
        }

        const err = 'input must be a buffer';

        this.status({fill: 'red', shape: 'dot', text: err});

        this.error(err);
      };

      const onClose = (removed, done) => {
        globalContext.set(hlsBase, undefined);

        mp4frag.resetCache();

        if (removed) {
          mp4frag.off('initialized', onInitialized);

          mp4frag.off('segment', onSegment);

          mp4frag.off('error', onError);

          this.off('input', onInput);

          this.off('close', onClose);

          this.status({fill: 'red', shape: 'ring', text: 'removed'});
        } else {
          this.status({fill: 'red', shape: 'dot', text: 'closed'});
        }

        done();
      };

      mp4frag.on('initialized', onInitialized);

      mp4frag.on('segment', onSegment);

      mp4frag.on('error', onError);

      this.on('input', onInput);

      this.on('close', onClose);

      this.status({fill: 'green', shape: 'ring', text: 'ready'});
    } catch (err) {
      this.status({fill: 'red', shape: 'dot', text: err});

      this.error(err);
    }
  }

  RED.nodes.registerType('mp4frag', Mp4FragNode);
};
