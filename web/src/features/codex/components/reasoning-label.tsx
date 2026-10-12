/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from 'motion/react'

import { reasoningEffortLabel } from '../lib/reasoning-effort'

function TierLabel(props: { value: string; reduced: boolean }) {
  const present = useIsPresent()
  return (
    <motion.span
      aria-hidden={!present || undefined}
      className='codex-reasoning-tier-label'
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -5 }}
      transition={{
        duration: props.reduced ? 0 : 0.22,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      {reasoningEffortLabel(props.value)}
    </motion.span>
  )
}

export function CodexReasoningLabel(props: { value: string }) {
  const reduced = useReducedMotion()
  return (
    <span className='codex-reasoning-label' data-effort={props.value}>
      <AnimatePresence initial={false}>
        <TierLabel key={props.value} value={props.value} reduced={!!reduced} />
      </AnimatePresence>
    </span>
  )
}
