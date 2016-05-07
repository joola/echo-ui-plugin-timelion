
var gulp = require('gulp');
var _ = require('lodash');
var yargs = require('yargs').argv;
var aws = require('aws-sdk');
var path = require('path');
var gulpUtil = require('gulp-util');
var mkdirp = require('mkdirp');
var Rsync = require('rsync');
var Promise = require('bluebird');
var eslint = require('gulp-eslint');
var rimraf = require('rimraf');
var zip = require('gulp-zip');
var fs = require('fs');
var child = require('child_process');
var semver = require('semver');
var mocha = require('gulp-mocha');

var pkg = require('./package.json');
var packageName = pkg.name  + '-' + pkg.version;

var buildDir = path.resolve(__dirname, 'build/kibana');
var packageRoot = path.resolve(__dirname, 'build');

var targetDir = path.resolve(__dirname, 'target');
var buildTarget = path.resolve(buildDir, pkg.name);
var kibanaPluginDir = path.resolve(__dirname, '../kibana/installedPlugins/' + pkg.name);

var include = [
  'package.json',
  'index.js',
  'node_modules',
  'public',
  'bower_components',
  'fit_functions',
  'handlers',
  'init.js',
  'lib',
  'routes',
  'series_functions',
  'timelion.json',
  'timelion.private.json'
];
var exclude = Object.keys(pkg.devDependencies).map(function (name) {
  return path.join('node_modules', name);
});

function writeDocs(done) {
  require('babel-core/register');
  var fs = require('fs');
  var helpish = require('./lib/functions_md');

  fs.writeFile(path.resolve(__dirname, 'FUNCTIONS.md'), helpish, function (err) {
    if (err) {
      return done(err);
    } else {
      done();
    }
  });
}

function syncPluginTo(dest, done) {
  mkdirp(dest, function (err) {
    if (err) return done(err);
    Promise.all(include.map(function (name) {
      var source = path.resolve(__dirname, name);
      try {fs.accessSync(source);} catch (e) {return;};
      return new Promise(function (resolve, reject) {
        var rsync = new Rsync();
        rsync
          .source(source)
          .destination(dest)
          .flags('uav')
          .recursive(true)
          .set('delete')
          .exclude(exclude)
          .output(function (data) {
            process.stdout.write(data.toString('utf8'));
          });
        rsync.execute(function (err) {
          if (err) {
            console.log(err);
            return reject(err);
          }
          resolve();
        });
      });
    }))
    .then(function () {
      done();
    })
    .catch(done);
  });
}

gulp.task('sync', function (done) {
  syncPluginTo(kibanaPluginDir, done);
});

gulp.task('docs', function (done) {
  writeDocs(done);
});

gulp.task('version', function (done) {
  var kibanaVersion = pkg.version.split('-')[0];
  var timelionVersion = pkg.version.split('-')[1];
  var newVersion = kibanaVersion + '-' + '0.1.' + (semver.patch(timelionVersion) + 1);
  child.exec('npm version --no-git-tag-version ' + newVersion, function () {
    console.log('Timelion version is ' + newVersion);
    done();
  });
});


gulp.task('lint', function (done) {
  return gulp.src(['server/**/*.js', 'public/**/*.js', 'public/**/*.jsx'])
    // eslint() attaches the lint output to the eslint property
    // of the file object so it can be used by other modules.
    .pipe(eslint())
    // eslint.format() outputs the lint results to the console.
    // Alternatively use eslint.formatEach() (see Docs).
    .pipe(eslint.formatEach())
    // To have the process exit with an error code (1) on
    // lint error, return the stream and pipe to failOnError last.
    .pipe(eslint.failOnError());
});

gulp.task('clean', function (done) {
  Promise.each([packageRoot, targetDir], function (dir) {
    return new Promise(function (resolve, reject) {
      rimraf(dir, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
  }).nodeify(done);
});

gulp.task('build', ['clean'], function (done) {
  syncPluginTo(buildTarget, done);
});

gulp.task('package', ['build'], function (done) {
  return gulp.src(path.join(packageRoot, '**', '*'))
    .pipe(zip(packageName + '.zip'))
    .pipe(gulp.dest(targetDir));
});

gulp.task('release', ['package'], function (done) {
  var filename = packageName + '.zip';

  // Upload to both places.
  var keys = ['kibana/timelion/', 'elastic/timelion/'];

  _.each(keys, function (key) {
    if (yargs.latest) {
      key += 'timelion-latest.zip';
    } else if (yargs.asVersion) {
      key += 'timelion-' + yargs.asVersion + '.zip';
    } else {
      key += filename;
    }
    var s3 = new aws.S3();
    var params = {
      Bucket: 'download.elasticsearch.org',
      Key: key,
      Body: fs.createReadStream(path.join(targetDir, filename))
    };
    s3.upload(params, function (err, data) {
      if (err) return done(err);
      gulpUtil.log('Finished', gulpUtil.colors.cyan('uploaded') + ' Available at ' + data.Location);
      keys.pop();
    });
  });

  function waitForUpload() {
    if (keys.length) {//we want it to match
      setTimeout(waitForUpload, 50);//wait 50 millisecnds then recheck
      return;
    }
    done();
    //real action
  }
  waitForUpload();
});

gulp.task('dev', ['sync'], function (done) {
  gulp.watch([
    'index.js',
    'node_modules',
    'public/**/*',
    'bower_components',
    'fit_functions/*',
    'handlers/**/*',
    'init.js',
    'lib/**/*',
    'routes/**/*',
    'series_functions/**/*',
    'timelion.json'
  ], ['sync', 'test']);
});

gulp.task('test', ['lint'], function () {
  require('babel-core/register');
  return gulp.src([
    'series_functions/__test__/**/*.js'
  ], { read: false })
  .pipe(mocha({ reporter: 'list' }))
  .on('error', gulpUtil.log);
});
