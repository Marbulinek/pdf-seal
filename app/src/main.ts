import { isDevMode } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { exposeDebugHandle } from './app/core/debug-handle';

bootstrapApplication(App, appConfig)
  .then((appRef) => {
    if (isDevMode()) exposeDebugHandle(appRef.injector);
  })
  .catch((err) => console.error(err));
