import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * "Page not found": any URL the router doesn't know, and share links with a
 * malformed session id. Rendered full-page, in place of the workspace shell
 * (see App). The server answers these URLs with a 404 status too.
 */
@Component({
  selector: 'main[appNotFoundPage]',
  imports: [RouterLink],
  template: `
    <img class="art" src="/assets/images/seal-404.webp" alt="A worried seal running from a pile of scattered PDFs" width="960" height="640" />
    <p class="code">404</p>
    <h1>Page not found</h1>
    <p>This page doesn't exist, or the share link has expired.</p>
    <a routerLink="/">Back to PDF Seal</a>
  `,
  styles: `
    :host {
      display: block;
      max-width: 520px;
      margin: 24px auto;
      padding: 32px;
      text-align: center;
      background: #fff;
      border: 1px solid #a8dadc;
      border-radius: 18px;
      box-shadow: 0 4px 18px rgba(30, 33, 51, 0.08);
      color: #1d3557;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .art {
      display: block;
      width: 100%;
      height: auto;
      margin: 0 0 16px;
    }
    .code {
      margin: 0;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #457b9d;
    }
    h1 {
      margin: 6px 0 8px;
      font-size: 1.4rem;
    }
    p {
      margin: 0 0 24px;
      color: #457b9d;
      line-height: 1.5;
    }
    a {
      display: inline-block;
      padding: 10px 20px;
      border-radius: 999px;
      background: #457b9d;
      color: #fff;
      font-weight: 600;
      text-decoration: none;
    }
    a:hover {
      background: #1d3557;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFoundPage {}
