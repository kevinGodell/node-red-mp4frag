'use strict';

module.exports = RED => {

  function UiMp4FragNode(config) {
    RED.nodes.createNode(this, config);

  }

  RED.nodes.registerType('ui_mp4frag', UiMp4FragNode);
};
