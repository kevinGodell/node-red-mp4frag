'use strict';

module.exports = ($scope, events) => {
  const waitForIt = (expression, maxRetry, retryDelay) => {
    let attempt = 0;

    return new Promise((resolve, reject) => {
      const checkExpression = () => {
        if (expression() === true) {
          return resolve(true);
        }

        if (++attempt > maxRetry) {
          return reject({ expression: expression.toString(), maxRetry, retryDelay });
        }

        setTimeout(checkExpression, retryDelay);
      };

      checkExpression();
    });
  };

  const hasHlsJs = () => {
    return /* typeof Hls === 'function' && */ Hls.isSupported() === true;
  };

  const hasHlsNative = () => {
    return $scope.video.canPlayType('application/vnd.apple.mpegurl') !== '';
  };

  const restartVideo = () => {
    alert(`restart video ${$scope.video.id}`);

    if (typeof $scope.restartTimeout !== 'undefined') {
      clearTimeout($scope.restartTimeout);
    }

    $scope.restartTimeout = setTimeout(() => {
      $scope.restartTimeout = undefined;
      resetVideo();
      initVideo();
    });
  };

  const resetVideo = errored => {
    if (typeof $scope.hls === 'object' && typeof $scope.hls.destroy === 'function') {
      $scope.hls.destroy();
    } else {
      $scope.video.pause();

      $scope.video.removeAttribute('src');

      $scope.video.load();

      $scope.video.onerror = undefined;
    }

    $scope.video.controls = false;

    $scope.video.poster = errored === true ? $scope.config.errorPoster : $scope.config.readyPoster;
  };

  const videoError = err => {
    console.error({ type: 'Error', videoId: $scope.video.id, details: err });

    resetVideo(true);
  };

  const playVideo = async () => {
    try {
      await $scope.video.play();

      $scope.video.controls = true;
    } catch (err) {
      videoError(err);
    }
  };

  const initVideo = () => {
    if (hasHlsJs() === true) {
      console.log({ type: 'Log', videoId: $scope.video.id, details: 'trying Hls.js' });

      $scope.hls = new Hls($scope.config.hlsJsConfig);

      $scope.hls.loadSource($scope.msg.payload);

      $scope.hls.attachMedia($scope.video);

      // todo check config.autoplay
      $scope.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // console.log('manifest parsed');
        playVideo();
      });

      $scope.hls.on(Hls.Events.ERROR, (event, data) => {
        const { type, details, fatal } = data;
        if (fatal) {
          switch (type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.error({
                type: 'Error',
                videoId: $scope.video.id,
                details,
                // details: 'fatal network error encountered, try to recover',
              });
              $scope.hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error({
                type: 'Error',
                videoId: $scope.video.id,
                details,
                // details: 'fatal media error encountered, try to recover',
              });
              $scope.hls.recoverMediaError();
              break;
            case Hls.ErrorTypes.OTHER_ERROR:
            default:
              videoError(data);
              break;
          }
        }
      });
    } else if (hasHlsNative() === true) {
      console.log({ type: 'Log', videoId: $scope.video.id, details: 'trying Hls native' });

      $scope.video.onerror = () => {
        videoError($scope.video.error);
      };

      $scope.video.src = $scope.msg.payload;

      $scope.video.addEventListener('loadedmetadata', () => {
        // console.log('loadedmetadata');

        playVideo();
      });
    } else {
      videoError('Hls.js and Hls native video not supported');
    }
  };

  // function called by ng-init='init(${JSON.stringify(config)})'
  $scope.init = config => {
    $scope.config = config;

    $scope.video = document.getElementById(config.videoID);
  };

  $scope.$watch('msg', async (newVal, oldVal) => {
    // console.log(typeof newVal, typeof oldVal);

    if (typeof newVal === 'undefined') {
      return;
    }

    // todo switch(msg.topic)...

    // resets video player
    resetVideo();

    if (newVal.payload.endsWith('.m3u8') === false) {
      console.warn({
        type: 'Warn',
        videoId: $scope.video.id,
        details: `video stopped due to payload: '${$scope.msg.payload}'`,
      });
      return;
    }

    try {
      /*
      todo: fix this ugly hack
      - handle lib race condition if hls.js not already cached in browser
      - Hls will initially be undefined when $scope.$watch('msg') is triggered
      - suspected lifecycle of node-red inserting script into head using default values,
      which results in script.async = true
      - condition can be easily illustrated when using private browsing mode
      in firefox and loading ui video player for first time
    */
      await waitForIt(() => typeof Hls === 'function', 10, 1000);
      initVideo();
    } catch (e) {
      videoError(e);
    }
  });

  /* const destroy = $scope.$on('$destroy', function () {
    console.log('destroyed');
    //destroy();
  });*/
};
