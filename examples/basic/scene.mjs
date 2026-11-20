// The title layer. It springs in, and after it settles every frame is the same picture (drawn only once).
import {settle, spring} from 'kasaneru/anim';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

export const css = `
.title{position:absolute;left:64px;top:56px;padding:14px 26px;border-radius:14px;background:rgba(10,14,24,.78);color:#fff;
  font:700 44px/1.2 system-ui,"Hiragino Sans","Noto Sans CJK JP",sans-serif;transform-origin:left center}
`;

export const scenes = {
  title: {
    render: (frame, props) => {
      const p = settle(spring({frame, fps: props.fps, damping: 14, stiffness: 170}));
      return `<div class="title" style="transform:scale(${0.8 + 0.2 * p});opacity:${Math.min(1, p * 1.5)}">${esc(props.title)}</div>`;
    },
  },
};
