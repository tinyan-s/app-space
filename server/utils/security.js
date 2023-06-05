'use strict';
let bcrypt = require('bcryptjs');
let crypto = require('crypto');
let fs = require('fs');
let Promise = require('bluebird');
let qetag = require('../utils/qetag');
let _ = require('lodash');
let log4js = require('log4js');
let log = log4js.getLogger("cps:utils:security");
let AppError = require('../utils/app-error');

let randToken = require('rand-token').generator({
  chars: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  source: crypto.randomBytes
});
let security = {};
module.exports = security;

security.md5 = function (str) {
  let md5sum = crypto.createHash('md5');
  md5sum.update(str);
  str = md5sum.digest('hex');
  return str;
}

security.passwordHashSync = function(password){
  return bcrypt.hashSync(password, bcrypt.genSaltSync(12));
}

security.passwordVerifySync = function(password, hash){
  return bcrypt.compareSync(password, hash)
}

security.randToken = function(num) {
  return randToken.generate(num);
}

security.parseToken = function(token) {
  return {identical: token.substr(-9,9), token:token.substr(0,28)}
}

security.fileSha256 = function (file) {
  return new Promise((resolve, reject) => {
    let rs = fs.createReadStream(file);
    let hash = crypto.createHash('md5');
    rs.on('data', hash.update.bind(hash));
    rs.on('error', (e) => {
      reject(e);
    });
    rs.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

security.stringSha256Sync = function (contents) {
  let sha256 = crypto.createHash('md5');
  sha256.update(contents);
  return sha256.digest('hex');
}

security.packageHashSync = function (jsonData) {
  let sortedArr = security.sortJsonToArr(jsonData);
  let manifestData = _.filter(sortedArr, (v) => {
    return !security.isPackageHashIgnored(v.path);
  }).map((v) => {
    return v.path + ':' + v.hash;
  });
  // log.debug('packageHashSync manifestData:', manifestData);
  let manifestString = JSON.stringify(manifestData.sort());
  manifestString = _.replace(manifestString, /\\\//g, '/');
  // log.debug('packageHashSync manifestString:', manifestString);
  return security.stringSha256Sync(manifestString);
}

//参数为buffer或者readableStream或者文件路径
security.qetag = function (buffer) {
  if (typeof buffer === 'string') {
    try {
      log.debug(`Check upload file ${buffer} fs.R_OK`);
      fs.accessSync(buffer, fs.R_OK);
      log.debug(`Pass upload file ${buffer}`);
    } catch (e) {
      log.error(e);
      return Promise.reject(new AppError.AppError(e.message))
    }
  }
  log.debug(`generate file identical`)
  return new Promise((resolve, reject) => {
    qetag(buffer, (data)=>{
      log.debug('identical:', data);
      resolve(data)
    });
  });
}

security.sha256AllFiles = function (files) {
  return new Promise((resolve, reject) => {
    let results = {};
    let length = files.length;
    let count = 0;
    files.forEach((file) => {
      security.fileSha256(file)
      .then((hash) => {
        results[file] = hash;
        count++;
        if (count == length) {
          resolve(results);
        }
      });
    });
  });
}

security.uploadPackageType = function (directoryPath) {
  return new Promise((resolve, reject) => {
    let recursive = require("recursive-readdir");
    // let path = require('path');
    // let slash = require("slash");
    recursive(directoryPath, (err, files) => {
      if (err) {
        log.error(new AppError.AppError(err.message));
        reject(new AppError.AppError(err.message));
      } else {
        if (files.length == 0) {
          log.debug(`uploadPackageType empty files`);
          reject(new AppError.AppError("empty files"));
        } else {
          let constName = require('../const');
          const AREGEX=/android\.bundle/
          const AREGEX_IOS=/main\.jsbundle/
          let packageType = 0;
          _.forIn(files, function (value) {
            if (AREGEX.test(value)) {
              packageType = constName.ANDROID;
              return false;
            }
            if (AREGEX_IOS.test(value)) {
              packageType = constName.IOS;
              return false;
            }
          });
          log.debug(`uploadPackageType packageType: ${packageType}`);
          resolve(packageType);
        }
      }
    });
  });
}

// some files are ignored in calc hash in client sdk
// https://github.com/Microsoft/react-native-code-push/pull/974/files#diff-21b650f88429c071b217d46243875987R15
security.isHashIgnored = function (relativePath) {
  if (!relativePath) {
    return true;
  }

  const IgnoreMacOSX = '__MACOSX/';
  const IgnoreDSStore = '.DS_Store';

  return relativePath.startsWith(IgnoreMacOSX)
    || relativePath === IgnoreDSStore
    || relativePath.endsWith(IgnoreDSStore);
}

security.isPackageHashIgnored = function (relativePath) {
  if (!relativePath) {
    return true;
  }

  // .codepushrelease contains code sign JWT
  // it should be ignored in package hash but need to be included in package manifest
  const IgnoreCodePushMetadata = '.codepushrelease';
  return relativePath === IgnoreCodePushMetadata
    || relativePath.endsWith(IgnoreCodePushMetadata)
    || security.isHashIgnored(relativePath);
}


security.calcAllFileSha256 = function (directoryPath) {
  return new Promise((resolve, reject) => {
    let recursive = require("recursive-readdir");
    let path = require('path');
    let slash = require("slash");
    recursive(directoryPath, (error, files) => {
      if (error) {
        log.error(error);
        reject(new AppError.AppError(error.message));
      } else {
        // filter files that should be ignored
        files = files.filter((file) => {
          let relative = path.relative(directoryPath, file);
          return !security.isHashIgnored(relative);
        });

        if (files.length == 0) {
          // log.debug(`calcAllFileSha256 empty files in directoryPath:`, directoryPath);
          reject(new AppError.AppError("empty files"));
        }else {
          security.sha256AllFiles(files)
          .then((results) => {
            let data = {};
            _.forIn(results, (value, key) => {
              let relativePath = path.relative(directoryPath, key);
              let matchresult = relativePath.match(/(\/|\\).*/);
              if (matchresult) {
                  relativePath = path.join('CodePush', matchresult[0]);
              }
              relativePath = slash(relativePath);
              data[relativePath] = value;
            });
            log.debug(`calcAllFileSha256 files:`, data);
            resolve(data);
          });
        }
      }
    });
  });
}

security.sortJsonToArr = function (json) {
  let rs = [];
  _.forIn(json, (value, key) => {
    rs.push({path:key, hash: value})
  });
  return _.sortBy(rs, (o) => o.path);
}
