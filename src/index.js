#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { Command } from 'commander';
import express from "express";
import cors from 'cors';
import bodyParser from 'body-parser';
import webpack from "webpack";
import { Path } from "path-parser";

const port = 3000;

const program = new Command();
program
  .requiredOption('--config <config>', 'Specify webpack config file')
  .option('-p --port [port]', `Specify port to use [${port}]`, port)
  .option('--cert [cert]', 'Specify certificate')
  .option('--no-cors', 'Disable default cors')
  .option('--key [key]', 'Specify key');

program.parse(process.argv);
const options = program.opts();

if (!options.config || ((options.cert || options.key) && !(options.cert && options.key))) {
  program.outputHelp();
  process.exit(1);
}

const config = require(path.join(process.cwd(), options.config));
const compiler = webpack(config);

compiler.hooks.assetEmitted.tap('claudia-api-webpack', (file, { content }) => {
  if (config.output.filename == file) {
    console.log('Reload claudia app...');
    reloadClaudiaApp(content.toString(), file);
  }
})

compiler.watch({}, (error, stats) => {
  console.log(stats.toString({ colors: true }));
});

let claudiaApp = null;
let routes = null;

function reloadClaudiaApp(source, filename) {
  try {
    const m = new module.constructor();
    m.paths = module.paths;
    m._compile(source, filename);

    claudiaApp = m.exports;

    const apiConfig = claudiaApp.apiConfig();
    routes = getRoutes(apiConfig.routes);
  }
  catch (error) {
    routes = [];
    console.error('Failed to compile module', error);
  }
}

const app = express();

if (options.cors) { app.use(cors()) }
app.use(bodyParser.text({ extended: true, limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));

app.all("*", (req, res) => {
  const params = getParams(req, routes);

  claudiaApp?.proxyRouter(params, {
    done: makeHandleResponse(res)
  });
});

let server;
if (options.cert && options.key) {
  const key = fs.readFileSync(options.key);
  const cert = fs.readFileSync(options.cert);
  server = https.createServer({ key, cert }, app);
}
else {
  server = http.createServer(app);
}

server.listen(options.port, function () {
  console.log(`Server listening on port ${options.port}.`);
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

  return routePaths.map(function (routePath) {
    const supportedMethods = Object.keys(routesObj[routePath] || {});
    const route = `/${routePath}`;
    return {
      resourcePath: route,
      supportedMethods,
      path: Path.createPath(route.replace(/{(.+?)}/g, ':$1'))
    };
  });
}

function makeHandleResponse(res) {
  return function (err, response) {
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