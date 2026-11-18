/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";
import { AgentSettingsView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { _t } from "../../../../../languageHandler";
import SettingsTab from "../SettingsTab";
import { SettingsSection } from "../../shared/SettingsSection";
import { AgentSettingsViewModel } from "../../../../../viewmodels/settings/AgentSettingsViewModel";
import type { AgentApi } from "../../../../../agent/AgentApi";
import { AgentAssistantRoom } from "../../../../../agent/AgentAssistantRoom";
import Modal from "../../../../../Modal";

interface Props {
    /** The agent of the platform */
    agent: AgentApi;
}

/**
 * User settings tab for the agent that replies to direct messages in agent mode.
 */
export function AgentUserSettingsTab({ agent }: Readonly<Props>): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => {
        const assistant = AgentAssistantRoom.sharedInstance();
        return new AgentSettingsViewModel({
            agent,
            onOpenAssistant: assistant.isAvailable
                ? () => {
                      void assistant.openRoom().then((opened) => {
                          // The chat shows behind the settings, so close them
                          if (opened) Modal.forceCloseAllModals();
                      });
                  }
                : undefined,
        });
    });
    return (
        <SettingsTab>
            <SettingsSection heading={_t("settings|agent|title")}>
                <AgentSettingsView vm={vm} />
            </SettingsSection>
        </SettingsTab>
    );
}
