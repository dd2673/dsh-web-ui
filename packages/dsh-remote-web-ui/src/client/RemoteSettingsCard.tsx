/**
 * The remote-control settings card: pairing security and device limits.
 * Registers into the `settings.plugin.item` slot the plugin-configuration
 * section renders, bound to the `remote-web-ui` settings namespace.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { PluginSettingsCard, ValueField, BooleanField } from './PluginSettingsCard.tsx'
import {
  CardForm, booleanField, numberField, textField,
  type CardActions, type CardShell, type FieldSpec, type FieldState as CardFieldState,
} from './settings-form.ts'
import { parseRelayUrl } from '../relay-url.ts'

/** Match the Host relay transport fence before a value can be persisted. */
function relayUrlField(field: string): FieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: parseRelayUrl,
  }
}

/** The remote-control fields this card edits (the namespace's full schema). */
export interface RemoteSettings {
  /** Master switch for the plugin. */
  enabled?: boolean
  /** Token lifetime in ms; the QR link dies after this. */
  tokenTtlMs?: number
  /** A device is "online" while its lastSeenAt is newer than this (ms). */
  offlineAfterMs?: number
  /** Hard cap on paired device sessions (oldest evicted when full). */
  maxDevices?: number
  /** Cookie name carrying the paired device id. */
  cookieName?: string
  /** Fence flag: whether non-loopback /api requests must carry a live paired-device cookie. */
  requirePairingForLan?: boolean
  /** Public (tunneled) base URL the QR link is built from when set. */
  publicBaseUrl?: string
  /** When on, the plugin runs its own Cloudflare quick tunnel automatically. */
  autoTunnel?: boolean
  /** Community relay service URL. Host identity and host credential stay internal. */
  relayUrl?: string
  /** Mobile composer: plain Enter sends; off means Enter inserts a newline. */
  mobileEnterToSend?: boolean
}

/** What the remote-control card renders. */
export interface RemoteSettingsCardState extends CardShell {
  /** Master switch. */
  enabled: CardFieldState
  /** Token lifetime. */
  tokenTtlMs: CardFieldState
  /** Device offline threshold. */
  offlineAfterMs: CardFieldState
  /** Paired-device cap. */
  maxDevices: CardFieldState
  /** Device cookie name. */
  cookieName: CardFieldState
  /** LAN fence flag. */
  requirePairingForLan: CardFieldState
  /** Public (tunneled) base URL. */
  publicBaseUrl: CardFieldState
  /** Auto public tunnel switch. */
  autoTunnel: CardFieldState
  /** User-facing relay service URL; blank disables the relay connection. */
  relayUrl: CardFieldState
  /** Whether only the Relay URL draft differs from persisted settings. */
  relayUrlDirty: boolean
  /** Whether the Relay URL is currently being persisted. */
  relayUrlSaving: boolean
  /** Whether the last Relay URL save was rejected. */
  relayUrlFailed: boolean
  /** Mobile composer Enter-to-send switch. */
  mobileEnterToSend: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface RemoteSettingsCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useRemoteSettingsCard. */
    remoteSettingsCard: SnapshotStore<RemoteSettingsCardState>
  }
  /** Save only the Relay URL draft and report whether it landed. */
  saveRelayUrl: () => Promise<boolean>
}

/** Bridges the `remote-web-ui` scope onto the card's staged form. */
export class RemoteSettingsCardController {
  private readonly form: CardForm<RemoteSettings>
  private readonly relayForm: CardForm<RemoteSettings>
  private readonly store: SnapshotStore<RemoteSettingsCardState>

  /** @param scope - the bound settings scope for the `remote-web-ui` namespace. */
  constructor(scope: SettingsScope<RemoteSettings>) {
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      numberField('tokenTtlMs'),
      numberField('offlineAfterMs'),
      numberField('maxDevices'),
      textField('cookieName'),
      booleanField('requirePairingForLan'),
      textField('publicBaseUrl'),
      booleanField('autoTunnel'),
      booleanField('mobileEnterToSend'),
    ])
    this.relayForm = new CardForm(scope, [relayUrlField('relayUrl')])
    this.store = this.form.bind(() => this.projection())
    // Relay edits use a separate CardForm so the compact panel can persist
    // exactly one field while both surfaces still share one draft.
    this.relayForm.bind(() => {
      const state = this.projection()
      this.store.set(state)
      return state
    })
  }

  private projection(): RemoteSettingsCardState {
    const shell = this.form.shell()
    const relayShell = this.relayForm.shell()
    return {
      ...shell,
      dirty: shell.dirty || relayShell.dirty,
      invalid: shell.invalid || relayShell.invalid,
      saving: shell.saving || relayShell.saving,
      failed: shell.failed || relayShell.failed,
      enabled: this.form.field('enabled'),
      tokenTtlMs: this.form.field('tokenTtlMs'),
      offlineAfterMs: this.form.field('offlineAfterMs'),
      maxDevices: this.form.field('maxDevices'),
      cookieName: this.form.field('cookieName'),
      requirePairingForLan: this.form.field('requirePairingForLan'),
      publicBaseUrl: this.form.field('publicBaseUrl'),
      autoTunnel: this.form.field('autoTunnel'),
      relayUrl: this.relayForm.field('relayUrl'),
      relayUrlDirty: relayShell.dirty,
      relayUrlSaving: relayShell.saving,
      relayUrlFailed: relayShell.failed,
      mobileEnterToSend: this.form.field('mobileEnterToSend'),
    }
  }

  private async saveAll(): Promise<void> {
    await this.relayForm.save()
    await this.form.save()
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): RemoteSettingsCardFace {
    const settings = this.form.actions()
    const relay = this.relayForm.actions()
    return {
      hooks: { remoteSettingsCard: this.store },
      edit: (field, text) => {
        if (field === 'relayUrl') relay.edit(field, text)
        else settings.edit(field, text)
      },
      resetField: (field) => {
        if (field === 'relayUrl') relay.resetField(field)
        else settings.resetField(field)
      },
      save: () => { void this.saveAll() },
      discard: () => {
        relay.discard()
        settings.discard()
      },
      saveRelayUrl: async () => {
        await this.relayForm.save()
        const state = this.relayForm.shell()
        return !state.failed && !state.dirty
      },
    }
  }
}

/** Props the renderer binds for the remote-control card. */
export type RemoteSettingsCardProps =
  PropsRuntime<'web-ui.plugin.item'>
  & PropsLocale<'remote'>
  & InjectFace<RemoteSettingsCardFace>

/**
 * Render the remote-control card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function RemoteSettingsCard(props: RemoteSettingsCardProps) {
  const { t } = props
  const state = props.useRemoteSettingsCard(snapshot => snapshot)
  const disabled = !state.writable
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidNumber'),
    disabled,
  }
  return (
    <PluginSettingsCard
      t={t}
      titleKey="settings.title"
      descriptionKey="settings.description"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="settings-remote-relay-url"
        label={t('settings.relayUrl')}
        hint={t('settings.relayUrlHint')}
        placeholder="wss://www.example.com/dsh-relay"
        {...fieldProps}
        {...state.relayUrl}
        invalidLabel={t('settings.invalidRelayUrl')}
        onEdit={(text) => { props.edit('relayUrl', text) }}
        onReset={() => { props.resetField('relayUrl') }}
      />
      <BooleanField
        id="settings-remote-enabled"
        label={t('settings.enabled')}
        hint={t('settings.enabledHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <ValueField
        id="settings-remote-token-ttl"
        label={t('settings.tokenTtlMs')}
        hint={t('settings.tokenTtlMsHint')}
        numeric
        {...fieldProps}
        {...state.tokenTtlMs}
        onEdit={(text) => { props.edit('tokenTtlMs', text) }}
        onReset={() => { props.resetField('tokenTtlMs') }}
      />
      <ValueField
        id="settings-remote-offline"
        label={t('settings.offlineAfterMs')}
        hint={t('settings.offlineAfterMsHint')}
        numeric
        {...fieldProps}
        {...state.offlineAfterMs}
        onEdit={(text) => { props.edit('offlineAfterMs', text) }}
        onReset={() => { props.resetField('offlineAfterMs') }}
      />
      <ValueField
        id="settings-remote-max-devices"
        label={t('settings.maxDevices')}
        hint={t('settings.maxDevicesHint')}
        numeric
        {...fieldProps}
        {...state.maxDevices}
        onEdit={(text) => { props.edit('maxDevices', text) }}
        onReset={() => { props.resetField('maxDevices') }}
      />
      <ValueField
        id="settings-remote-cookie"
        label={t('settings.cookieName')}
        hint={t('settings.cookieNameHint')}
        {...fieldProps}
        {...state.cookieName}
        onEdit={(text) => { props.edit('cookieName', text) }}
        onReset={() => { props.resetField('cookieName') }}
      />
      <BooleanField
        id="settings-remote-fence"
        label={t('settings.requirePairingForLan')}
        hint={t('settings.requirePairingForLanHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.requirePairingForLan}
        onEdit={(text) => { props.edit('requirePairingForLan', text) }}
        onReset={() => { props.resetField('requirePairingForLan') }}
      />
      <ValueField
        id="settings-remote-public-base"
        label={t('settings.publicBaseUrl')}
        hint={t('settings.publicBaseUrlHint')}
        placeholder="https://example.trycloudflare.com"
        {...fieldProps}
        {...state.publicBaseUrl}
        onEdit={(text) => { props.edit('publicBaseUrl', text) }}
        onReset={() => { props.resetField('publicBaseUrl') }}
      />
      <BooleanField
        id="settings-remote-auto-tunnel"
        label={t('settings.autoTunnel')}
        hint={t('settings.autoTunnelHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.autoTunnel}
        onEdit={(text) => { props.edit('autoTunnel', text) }}
        onReset={() => { props.resetField('autoTunnel') }}
      />
      <BooleanField
        id="settings-remote-mobile-enter"
        label={t('settings.mobileEnterToSend')}
        hint={t('settings.mobileEnterToSendHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.mobileEnterToSend}
        onEdit={(text) => { props.edit('mobileEnterToSend', text) }}
        onReset={() => { props.resetField('mobileEnterToSend') }}
      />
    </PluginSettingsCard>
  )
}
