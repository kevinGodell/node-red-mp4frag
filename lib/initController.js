'use strict';

module.exports = ($scope, events) => {
  const checkLib = expression => {
    const maxRetry = 10;
    const retryDelay = 2000;
    let attempt = 0;
    return new Promise((resolve, reject) => {
      if (expression() === true) {
        return resolve(`${expression.toString()} === true`);
      }
      const interval = setInterval(() => {
        if (expression() === true) {
          clearInterval(interval);
          return resolve(`${expression.toString()} === true`);
        }
        if (++attempt >= maxRetry) {
          clearInterval(interval);
          return reject(`${expression.toString()} === false`);
        }
      }, retryDelay);
    });
  };

  const hasHlsJs = () => {
    return typeof Hls === 'function' && Hls.isSupported() === true;
  };

  const hasHlsNative = () => {
    return $scope.video.canPlayType('application/vnd.apple.mpegurl') !== '';
  };

  const resetVideo = errored => {
    $scope.video.pause();

    if (typeof $scope.hls === 'object' && typeof $scope.hls.destroy === 'function') {
      $scope.hls.destroy();
    } else {
      $scope.video.removeAttribute('src');

      $scope.video.load();

      $scope.video.onerror = undefined;
    }

    $scope.video.controls = false;

    $scope.video.poster = errored === true ? $scope.config.errorPoster : $scope.config.readyPoster;
  };

  const videoError = err => {
    console.error(`Error: id = ${$scope.video.id} details = ${err}`);

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
      console.log(`Log: id = ${$scope.video.id} details = trying Hls.js`);

      $scope.hls = new Hls({
        liveDurationInfinity: true,
        liveBackBufferLength: 0,
        maxBufferLength: 5, // default 30
        manifestLoadingTimeOut: 1000,
        manifestLoadingMaxRetry: 10,
        manifestLoadingRetryDelay: 500,
      });

      $scope.hls.loadSource($scope.msg.payload);

      $scope.hls.attachMedia($scope.video);

      // todo check config.autoplay
      $scope.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // console.log('manifest parsed');
        playVideo();
      });

      $scope.hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('fatal network error encountered, try to recover');
              $scope.hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('fatal media error encountered, try to recover');
              $scope.hls.recoverMediaError();
              break;
            default:
              // console.log('cannot recover, calling hls.destroy()');
              videoError(data);
              break;
          }
        }
      });
    } else if (hasHlsNative() === true) {
      console.log(`Log: id = ${$scope.video.id} details = trying Hls native`);

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
      console.warn(`Warn: id = ${$scope.video.id} details = video stopped due to payload: '${$scope.msg.payload}'`);
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
      await checkLib(() => typeof Hls === 'function');
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
