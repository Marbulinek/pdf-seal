import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Yes/no properties as one row of chips instead of a "Required: No" row each. */
@Component({
  selector: 'app-ov-flags',
  template: `
    <ul class="ov-flags">
      @for (f of flags(); track f[0]) {
        <li class="ov-flag" [class.is-on]="f[1]">
          <span class="icon {{ f[1] ? 'icon-check' : 'icon-minus' }}" aria-hidden="true"></span>{{ f[0] }}<span class="sr-only">: {{ f[1] ? 'yes' : 'no' }}</span>
        </li>
      }
    </ul>
  `,
  styleUrl: './ov-flags.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class OvFlags {
  readonly flags = input.required<[string, boolean][]>();
}
