'use strict';

module.exports = RED => {
  const { _ } = RED; // locale string getter

  const { createNode, getNode } = RED.nodes;

  const { addWidget } = RED.require('node-red-dashboard')(RED);

  const HLS_JS_SOURCE = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.light.min.js';

  const NODE_TYPE = 'ui_mp4frag';

  class UiMp4FragNode {
    constructor(config) {
      createNode(this, config);

      // return early if ui_group does not exist
      if (UiMp4FragNode._uiGroupExists(config) === true) {
        this._bodyDone = undefined; // will be defined in _addToBody()

        this._addToBody(config); // adds the html markup to the body

        UiMp4FragNode._addToHead(); // adds the script to the head (only once)

        this.on('input', this._onInput); // listen to the input event

        this.on('close', this._onClose); // listen to the close event

        this.status({ fill: 'green', shape: 'ring', text: 'ready' });
      } else {
        this.error(_('ui_mp4frag.error.no-group'));

        this.status({ fill: 'red', shape: 'dot', text: 'ui_mp4frag.error.no-group' });
      }
    }

    static _uiGroupExists(config) {
      const group = getNode(config && config.group);

      return !!(group && group.type === 'ui_group');
    }

    static _addToHead() {
      if (UiMp4FragNode._nodeCount++ === 0 && UiMp4FragNode._headDone === undefined) {
        UiMp4FragNode._headDone = addWidget({
          node: '',
          group: '',
          order: 0,
          width: 0,
          height: 0,
          format: `<script src="${HLS_JS_SOURCE}"></script>`,
          templateScope: 'global', // global causes `format` to be inserted in <head>
          emitOnlyNewValues: false,
          forwardInputMessages: false,
          storeFrontEndInputAsState: false,
        });
      }
    }

    static _removeFromHead() {
      if (--UiMp4FragNode._nodeCount === 0 && typeof UiMp4FragNode._headDone === 'function') {
        UiMp4FragNode._headDone();

        UiMp4FragNode._headDone = undefined;
      }
    }

    _addToBody(config) {
      this._bodyDone = addWidget({
        node: this,
        group: config.group,
        order: config.order || 0,
        width: config.width,
        height: config.height,
        format: '<img alt="baby yoda" src="https://miro.medium.com/max/1200/1*mk1-6aYaf_Bes1E3Imhc0A.jpeg"/>',
        templateScope: 'local', // local causes `format` to be inserted in <body>
        emitOnlyNewValues: false,
        forwardInputMessages: false,
        storeFrontEndInputAsState: false,
        convertBack: function (value) {
          return value;
        },
        beforeEmit: function (msg, value) {
          return { msg: msg };
        },
        beforeSend: function (msg, orig) {
          if (orig) {
            return orig.msg;
          }
        },
        initController: function ($scope, events) {
          console.log($scope);

          // Remark: all client-side functions should be added here!
          // If added above, it will be server-side functions which are not available at the client-side ...
        },
      });
    }

    _removeFromBody() {
      if (typeof this._bodyDone === 'function') {
        this._bodyDone();

        this._bodyDone = undefined;
      }
    }

    _onInput(msg) {
      this.send(msg);
    }

    _onClose(removed, done) {
      this.off('input', this._onInput);

      this.off('close', this._onClose);

      UiMp4FragNode._removeFromHead();

      this._removeFromBody();

      console.log({ removed }); // removed/disabled === true

      if (typeof done === 'function') {
        done();
      }
    }
  }

  UiMp4FragNode._nodeCount = 0; // increment in (successful) constructor, decrement on close event

  UiMp4FragNode._headDone = undefined; // will be defined in _addToHead()

  RED.nodes.registerType(NODE_TYPE, UiMp4FragNode);
};
