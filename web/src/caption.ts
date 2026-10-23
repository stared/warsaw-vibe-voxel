import { $, el } from './util';

// while the city loads: what is arriving, and how many of its tile files are in, with a bar for the same count
export class Caption {
  private readonly box = el('div', 'caption off', '<span class="txt"><span class="st"></span><span class="n"></span></span><span class="bar"><i></i></span>');
  private readonly stage = $('.st', this.box);
  private readonly count = $('.n', this.box);
  private readonly fill = $('i', this.box);
  private finished = false;

  show(stage: string, done: number, total: number) {
    if (this.finished) return;
    this.stage.textContent = stage;
    this.count.textContent = `${done} / ${total} tiles`;
    this.fill.style.width = `${(100 * Math.min(1, done / Math.max(1, total))).toFixed(1)}%`;
    this.box.classList.remove('off');
  }

  finish(stage: string, total: number) {
    if (this.finished) return;
    this.show(stage, total, total);
    this.finished = true;
    setTimeout(() => this.box.classList.add('off'), 1500);
  }
}
