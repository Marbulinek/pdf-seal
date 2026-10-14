import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-ov-section-title',
  template: `<p class="overview-section-title"><span class="icon {{ icon() }}" aria-hidden="true"></span> {{ title() }}</p>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class OvSectionTitle {
  readonly icon = input.required<string>();
  readonly title = input.required<string>();
}
