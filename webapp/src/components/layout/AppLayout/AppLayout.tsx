'use client'

import { GlobalHeader } from '../GlobalHeader'
import { Footer } from '../Footer'
import { DisclaimerGate } from '../DisclaimerGate'
import { UpdateNotification } from '../UpdateNotification'
import styles from './AppLayout.module.css'

interface AppLayoutProps {
  children: React.ReactNode
  pluginsEnabled?: boolean
}

export function AppLayout({ children, pluginsEnabled = false }: AppLayoutProps) {
  return (
    <div className={styles.layout}>
      <GlobalHeader pluginsEnabled={pluginsEnabled} />
      <main className={styles.main}>
        <DisclaimerGate>{children}</DisclaimerGate>
      </main>
      <Footer />
      <UpdateNotification />
    </div>
  )
}
