import { useState } from 'react'

interface ButtonProps {
  profile: string
  /** Called after `aws sso login` succeeds, so the caller can retry what failed. */
  onDone: () => void
}

/**
 * Runs `aws sso login --profile …`, which opens the browser, and waits for the
 * developer to finish there. Its own failure text is shown beside the button
 * rather than thrown, since the caller is already showing an error.
 */
export function SsoLoginButton({ profile, onDone }: ButtonProps) {
  const [waiting, setWaiting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    setWaiting(true)
    setFailure(null)
    try {
      await window.api.aws.ssoLogin(profile)
      onDone()
    } catch (err) {
      setFailure((err as Error).message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''))
    } finally {
      setWaiting(false)
    }
  }

  return (
    <>
      <button className="primary" onClick={() => void run()} disabled={waiting}>
        {waiting ? 'Waiting for the browser…' : `Sign in with aws sso login (${profile})`}
      </button>
      {failure && (
        <div className="q-note bad" role="alert">
          {failure}
        </div>
      )}
    </>
  )
}

interface PromptProps extends ButtonProps {
  message: string
  onCancel: () => void
}

/** Shown when Connect finds the AWS SSO session missing or expired. */
export function SsoPrompt({ profile, message, onDone, onCancel }: PromptProps) {
  return (
    <div className="q-overlay" onMouseDown={onCancel}>
      <div className="q-modal" role="dialog" aria-modal="true" aria-label="AWS sign-in required" onMouseDown={(e) => e.stopPropagation()}>
        <h2>AWS sign-in required</h2>
        <div className="q-body">
          <div className="q-note bad" role="alert">{message}</div>
          <div className="q-note">Signing in opens your browser. Quarry connects again once it finishes.</div>
        </div>
        <div className="q-footer">
          <div className="spacer" />
          <button onClick={onCancel}>Cancel</button>
          <SsoLoginButton profile={profile} onDone={onDone} />
        </div>
      </div>
    </div>
  )
}
