import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ChainNode } from '../features/certificates/certificates-model';
import { CertDot } from './cert-dot';

/**
 * A certificate chain drawn top-down (root first), or a flat list. Clicking a
 * certificate opens it; clicking the signature node points at its field.
 */
@Component({
  selector: 'app-cert-chain',
  imports: [CertDot],
  template: `
    @if (nodes().length) {
      <ol class="cert-chain" [class.is-flat]="flat()">
        @for (node of nodes(); track node.index) {
          <li
            class="cert-chain-node is-{{ node.status }}"
            [class.is-signature]="!!node.signatureField"
            [class.is-missing]="node.missing"
            [class.is-root]="node.isRoot"
            [class.is-selected]="!!node.certId && node.certId === selectedId()"
            [style.--depth]="node.depth"
            [style.--i]="node.index"
            [attr.data-cert-id]="node.certId"
            [attr.data-cert-signature-field]="node.signatureField"
          >
            @if (node.missing) {
              <div class="cert-node-body">
                <app-cert-dot [status]="node.status" />
                <span class="cert-node-text">
                  <span class="cert-node-name">{{ node.name }}</span>
                  <span class="cert-node-role">{{ node.role }}</span>
                  @if (node.detail) {
                    <span class="cert-node-detail">{{ node.detail }}</span>
                  }
                </span>
              </div>
            } @else {
              <button type="button" class="cert-node-body" [attr.data-cert-action]="node.signatureField ? 'show-field' : 'open-cert'" (click)="activate(node)">
                <app-cert-dot [status]="node.status" />
                <span class="cert-node-text">
                  <span class="cert-node-name">{{ node.name }}</span>
                  <span class="cert-node-role">{{ node.role }}</span>
                  @if (node.detail) {
                    <span class="cert-node-detail">{{ node.detail }}</span>
                  }
                </span>
              </button>
            }
          </li>
        }
      </ol>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class CertChain {
  readonly nodes = input.required<ChainNode[]>();
  readonly flat = input(false);
  /** The certificate open in the sheet, highlighted in the chain. */
  readonly selectedId = input<string | null>(null);
  readonly openCert = output<string>();
  readonly showField = output<string>();

  protected activate(node: ChainNode): void {
    if (node.signatureField) this.showField.emit(node.signatureField);
    else if (node.certId) this.openCert.emit(node.certId);
  }
}
