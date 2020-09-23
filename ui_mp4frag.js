'use strict';

module.exports = RED => {
  const { _ } = RED; // locale string getter

  const { createNode, getNode, registerType } = RED.nodes;

  const { addWidget } = RED.require('node-red-dashboard')(RED);

  const { uiMp4fragHlsJs = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js' } = RED.settings;

  const NODE_TYPE = 'ui_mp4frag';

  const initController = require('./lib/initController.js');

  class UiMp4FragNode {
    constructor(config) {
      createNode(this, config);

      // return early if ui_group does not exist
      if (UiMp4FragNode.uiGroupExists(config) === true) {
        config.videoID = `video_${NODE_TYPE}_${this.id}`;

        UiMp4FragNode.sanitizeHlsJsConfig(config);

        UiMp4FragNode.addToHead(); // adds the script to the head (only once)

        UiMp4FragNode.addToBody(this, config); // adds the html markup to the body

        // this._onInput = msg => void UiMp4FragNode.onInput(this, msg); // bind `this` using fat arrow, void to indicate no return val

        // this.on('input', this._onInput); // listen to the input event

        this._onClose = (removed, done) => void UiMp4FragNode.onClose(this, removed, done);

        this.on('close', this._onClose); // listen to the close event

        this.status({ fill: 'green', shape: 'ring', text: 'ready' });
      } else {
        this.error(_('ui_mp4frag.error.no-group'));

        this.status({ fill: 'red', shape: 'dot', text: 'ui_mp4frag.error.no-group' });
      }
    }

    static uiGroupExists(config) {
      const group = getNode(config && config.group);

      return !!(group && group.type === 'ui_group');
    }

    static addToHead() {
      if (UiMp4FragNode.headDone === undefined && UiMp4FragNode.nodeCount++ === 0) {
        UiMp4FragNode.headDone = addWidget({
          node: '',
          group: '',
          order: 0,
          width: 0,
          height: 0,
          format: UiMp4FragNode.renderInHead(),
          templateScope: 'global', // global causes `format` to be inserted in <head>
          emitOnlyNewValues: false,
          forwardInputMessages: false,
          storeFrontEndInputAsState: false,
        });
      }
    }

    static removeFromHead() {
      if (typeof UiMp4FragNode.headDone === 'function' && --UiMp4FragNode.nodeCount === 0) {
        UiMp4FragNode.headDone();

        UiMp4FragNode.headDone = undefined;
      }
    }

    static addToBody(node, config) {
      node._bodyDone = addWidget({
        node: node,
        group: config.group,
        order: config.order || 0,
        width: config.width,
        height: config.height,
        format: UiMp4FragNode.renderInBody(config),
        templateScope: 'local', // local causes `format` to be inserted in <body>
        emitOnlyNewValues: false,
        forwardInputMessages: false, // true = we do not need to listen to on input event and manually forward msg
        storeFrontEndInputAsState: false,
        convertBack: value => {
          // console.log('convert back', {value});
          return value;
        },
        beforeEmit: (msg, value) => {
          // console.log('before emit', {msg}, {value});
          return { msg };
        },
        beforeSend: (msg, orig) => {
          // console.log('before send', {msg}, {orig});
          if (orig) {
            return orig.msg;
          }
        },
        initController: initController,
      });
    }

    static removeFromBody(node) {
      if (typeof node._bodyDone === 'function') {
        node._bodyDone();

        node._bodyDone = undefined;
      }
    }

    /* static onInput(node, msg) {
      node.send(msg);
    }*/

    static onClose(node, removed, done) {
      // node.removeListener('input', node._onInput);

      // node._onInput = undefined;

      node.removeListener('close', node._onClose);

      node._onClose = undefined;

      UiMp4FragNode.removeFromHead();

      UiMp4FragNode.removeFromBody(node);

      if (removed) {
        node.status({ fill: 'red', shape: 'ring', text: 'removed' });
      } else {
        node.status({ fill: 'red', shape: 'dot', text: 'closed' });
      }

      if (typeof done === 'function') {
        done();
      }
    }

    static renderInHead() {
      return String.raw`<script id="${NODE_TYPE}_hls_js" type="text/javascript" src="${uiMp4fragHlsJs}"></script>`;
      // return String.raw`<script>const ${NODE_TYPE}_script = document.createElement('script');${NODE_TYPE}_script.type = 'text/javascript';${NODE_TYPE}_script.src = '${uiMp4fragHlsJs}';${NODE_TYPE}_script.async = false;${NODE_TYPE}_script.defer = false;const ${NODE_TYPE}_head = document.getElementsByTagName('head')[0];${NODE_TYPE}_head.appendChild(${NODE_TYPE}_script);</script>`;
    }

    static renderInBody(config) {
      const style = 'padding:0;margin:0;width:100%;height:100%;overflow:hidden;border:1px solid grey;';
      const videoOptions = 'muted playsinline';
      return String.raw`<div style="${style}" ng-init='init(${JSON.stringify(config)})'>
  <video id="${config.videoID}" style="width:100%;height:100%;" ${videoOptions} poster="${config.readyPoster}"></video>
</div>`;
    }

    // return object if good, undefined if bad
    static jsonParse(str) {
      try {
        const value = JSON.parse(str);
        const type = typeof value;
        return [value, type];
      } catch (e) {
        console.warn(e);
        return [undefined, 'undefined'];
      }
    }

    static sanitizeHlsJsConfig(config) {
      const { hlsJsConfig } = config;

      const [value, type] = UiMp4FragNode.jsonParse(hlsJsConfig);

      config.hlsJsConfig = type === 'object' && value !== null ? value : {};
    }
  }

  UiMp4FragNode.nodeCount = 0; // increment in (successful) constructor, decrement on close event

  const UiMp4FragExtra = {
    settings: {
      uiMp4fragHlsJs: { value: uiMp4fragHlsJs, exportable: true },
    },
  };

  registerType(NODE_TYPE, UiMp4FragNode, UiMp4FragExtra);
};
