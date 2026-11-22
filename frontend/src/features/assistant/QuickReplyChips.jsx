import React from 'react';

/**
 * QuickReplyChips — Tappable quick options (Doctors, Pets, Dates, Slots, Yes/No)
 * Adheres to 44px minimum touch target guidelines and accessible focus styles.
 */
export function QuickReplyChips({ chips = [], onSelect, onChipClick, disabled = false }) {
  if (!chips || chips.length === 0) return null;
  const handleClick = onSelect || onChipClick;

  return (
    <div className="assistant-chips-container" role="group" aria-label="Quick reply options">
      {chips.map((chip, idx) => (
        <button
          key={`${chip.label}-${idx}`}
          type="button"
          className="assistant-chip-btn"
          disabled={disabled}
          onClick={() => handleClick?.(chip.action)}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

