#!/usr/bin/env node

import path from "path";
import commander from 'commander';
import express from "express";
import webpack from "webpack";
import PathParser from "path-parser";

const port = 3000;

commander
  .option('--config <config>', 'Specify webpack config file')
  .option('-p --port [port]', `Specify port to use [${port}]`, port)
  .parse(process.argv);

if (!commander.config) {
  commander.outputHelp();
  process.exit(1);
}

const config = require(path.join(process.cwd(), commander.config));
const compiler = webpack(config);

compiler.watch({}, (error, stats) => {
  console.log(stats.toString({ colors: true }));
  if (error || stats.hasErrors()) {
    return;
  }

  if (stats.compilation.chunks.length !== 1 || stats.compilation.chunks[0].files.length !== 1) {
    return console.error('Unsupported compilation result');
  }

  const file = stats.compilation.chunks[0].files[0];
  const source = stats.compilation.assets[file].source();

  reloadClaudiaApp(source, file);
});

let claudiaApp = null;
let routes = null;

function reloadClaudiaApp(source, filename) {
  const m = new module.constructor();
  m.paths = module.paths;
  m._compile(source, filename);

  claudiaApp = m.exports;

  const apiConfig = claudiaApp.apiConfig();
  routes = getRoutes(apiConfig.routes);
}

const app = express();

app.all("*", (req, res) => {
  const params = getParams(req, routes);

  claudiaApp.proxyRouter(params, {
    done: makeHandleResponse(res)
  });
});

app.listen(commander.port, function() {
  console.log(`Server listening on port ${commander.port}.`);
});

function getPathParams(req, routes) {
  const parsedPath = req._parsedUrl.pathname;
  for (const route of routes) {
    const isSupported = route.supportedMethods.indexOf(req.method) !== -1;
    const pathParameters = route.path.test(parsedPath);

    if (isSupported && pathParameters) {
      return {
        resourcePath: route.resourcePath,
        pathParameters
      };
    }
  }

  return {
    resourcePath: parsedPath,
    pathParameters: {}
  };
}

function getParams(req, routes) {
  const pathParams = getPathParams(req, routes);

  return {
    requestContext: {
      resourcePath: pathParams.resourcePath,
      httpMethod: req.method
    },
    headers: req.headers,
    queryStringParameters: req.query,
    body: req.body,
    pathParameters: pathParams.pathParameters
  };
}

function getRoutes(routesObj) {
  const routePaths = Object.keys(routesObj);

  return routePaths.map(function(routePath) {
    const supportedMethods = Object.keys(routesObj[routePath] || {});
    const route = `/${routePath}`;
    return {
      resourcePath: route,
      supportedMethods,
      path: PathParser.createPath(route.replace(/{(.+?)}/g, ':$1'))
    };
  });
}

function makeHandleResponse(res) {
  return function(err, response) {
    if (err) {
      const body = {
        message: err.message
      };
      return res.status(500).send(body);
    }
    return res
      .set(response.headers || {})
      .status(response.statusCode || 200)
      .send(response.body || {});
  };
}