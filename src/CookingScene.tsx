// A small looping kitchen scene shown while a recipe is generated: a cook
// chops a carrot, tosses the pieces into a pot and stirs it. It is purely
// decorative; the surrounding status text is what screen readers announce.
// Under reduced motion the CSS leaves it as a still illustration.
export function CookingScene() {
  return (
    <svg
      className="cooking-scene"
      viewBox="0 0 240 120"
      aria-hidden="true"
      focusable="false"
    >
      <g className="scene-steam">
        <path d="M176 58c-4-5 4-9 0-14" />
        <path d="M185 56c-4-5 4-9 0-14" />
        <path d="M194 58c-4-5 4-9 0-14" />
      </g>
      <g className="scene-cook">
        <circle cx="36" cy="42" r="10" />
        <rect x="24" y="56" width="24" height="46" rx="11" />
      </g>
      <rect
        className="scene-counter"
        x="8"
        y="96"
        width="224"
        height="6"
        rx="3"
      />
      <rect
        className="scene-board"
        x="56"
        y="90"
        width="58"
        height="6"
        rx="2"
      />
      <g className="scene-carrot">
        <rect x="84" y="84" width="24" height="6" rx="3" />
        <path d="M108 87l6-4M108 87l6 1" />
      </g>
      <circle className="scene-piece" cx="66" cy="87" r="3" />
      <circle className="scene-piece" cx="73" cy="87" r="3" />
      <circle className="scene-piece" cx="80" cy="87" r="3" />
      <g className="scene-knife">
        <path className="scene-arm" d="M44 64L74 80" />
        <path className="scene-blade" d="M73 78l4-1 4 12-4 1z" />
      </g>
      <path className="scene-spoon" d="M188 86L200 44" />
      <g className="scene-pot">
        <rect x="156" y="66" width="58" height="6" rx="3" />
        <rect x="160" y="70" width="50" height="26" rx="6" />
        <rect x="150" y="74" width="10" height="5" rx="2.5" />
        <rect x="210" y="74" width="10" height="5" rx="2.5" />
      </g>
    </svg>
  );
}
