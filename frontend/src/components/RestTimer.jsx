import { useEffect } from 'react'
import { useUI } from '../store/useUI.js'
import { useStore } from '../store/useStore.js'
import { t, exerciseNameFor } from '../lib/i18n.js'
import { exOr } from '../lib/exercises.js'
import { capWords } from '../lib/format.js'
import { upNextAfterRest } from '../lib/active-workout-order.js'
import { Button } from './ui.jsx'
import { REST_STEP } from '../lib/rest-timing.js'

const clock = sec => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0')

// One bar, two meanings: the rest countdown between sets, and the work countdown during a
// timed set (issue #16). They are mutually exclusive by construction — startWork() stops any
// running rest — so the bar can never have to show both, and a work set gets its own colour
// plus a "Done" that logs the time actually held.
export default function RestTimer() {
  const timer = useUI(s => s.timer)
  const work = useUI(s => s.work)
  const { addRest, stopRest, finishWorkEarly, stopWork } = useUI()
  const active = useStore(s => s.S.active)
  const on = work || timer
  // The bar is fixed above the tab bar and floats over whatever is beneath it — during a
  // rest that was the next set's row. Extra bottom padding lets the page scroll clear.
  useEffect(() => {
    document.body.classList.toggle('resting', !!on)
    return () => document.body.classList.remove('resting')
  }, [!!on])
  if (!on) return null
  const pct = (on.left / on.total) * 100

  if (work) return (
    <div id="timer" className="working">
      <div className="t">{clock(work.left)}</div>
      <div className="grow">
        {work.label && <div className="lbl">{work.label}</div>}
        <div className="bar"><i style={{ width: pct + '%' }} /></div>
      </div>
      <Button size="sm" onClick={stopWork}>{t('Cancel')}</Button>
      <Button size="sm" variant="primary" icon="check" onClick={finishWorkEarly}>{t('Done')}</Button>
    </div>
  )
  // Three controls plus the clock don't fit one line on a phone — at 360px the bar is left
  // with about 30px and stops saying anything. So the rest variant stacks: clock and bar
  // read at a glance, controls get their own row. −15 and +15 sit together in number-line
  // order; Skip is pushed to the far edge, away from the button you tap to buy more time.
  // A rest that closes an exercise leads into another one, and the bar names it (lib/
  // active-workout-order.js upNextAfterRest) above the progress line, in the clock's row height.
  const next = upNextAfterRest(active, timer.forIdx)
  return (
    <div id="timer" className="rest">
      <div className="head">
        <div className="t">{clock(timer.left)}</div>
        <div className="grow">
          {next && <div className="lbl">{t('Up next: {0}', next.map(i => capWords(exerciseNameFor(exOr(active.entries[i].id)))).join(' + '))}</div>}
          <div className="bar"><i style={{ width: pct + '%' }} /></div>
        </div>
      </div>
      <div className="acts">
        <Button size="sm" icon="minus" onClick={() => addRest(-REST_STEP)}>{REST_STEP}s</Button>
        <Button size="sm" icon="plus" onClick={() => addRest(REST_STEP)}>{REST_STEP}s</Button>
        <Button size="sm" variant="primary" className="skip" onClick={stopRest}>{t('Skip')}</Button>
      </div>
    </div>
  )
}
