<script setup lang="ts">
import { computed } from "vue";
import AppSidebar from "./components/AppSidebar.vue";
import RunProgress from "./components/RunProgress.vue";
import ConfirmDialog from "./dialogs/ConfirmDialog.vue";
import MarkDialog from "./dialogs/MarkDialog.vue";
import ProjectDialog from "./dialogs/ProjectDialog.vue";
import ProjectPicker from "./dialogs/ProjectPicker.vue";
import RepoDialog from "./dialogs/RepoDialog.vue";
import ResultSheet from "./dialogs/ResultSheet.vue";
import SplitDialog from "./dialogs/SplitDialog.vue";
import TemplateDialog from "./dialogs/TemplateDialog.vue";
import { useLifecycle } from "./store/useLifecycle";
import { markFor } from "./store/useMark";
import { splitItem } from "./store/usePool";
import { projOpen, projPickOpen, repoOpen } from "./store/useProjects";
import { tplOpen } from "./store/useSettings";
import { sheet } from "./store/useTasks";
import { confirmReq } from "./store/useConfirm";
import { err, msg } from "./store/useToast";
import { view } from "./store/useView";
import DoneView from "./views/DoneView.vue";
import SettingsView from "./views/SettingsView.vue";
import TasksView from "./views/TasksView.vue";
import TerminalsView from "./views/TerminalsView.vue";
import WbView from "./views/WbView.vue";

useLifecycle();

// KeepAlive：切走再回来不销毁——展开态、终端滚动位置、已渲染行数都留着。
// 注意：KeepAlive 里必须始终有且只有一个组件（page 用 TasksView 兜底，不会为 null）。
const PAGES = {
  tasks: TasksView,
  terminals: TerminalsView,
  done: DoneView,
  wb: WbView,
  settings: SettingsView,
};
const page = computed(() => PAGES[view.value as keyof typeof PAGES] || TasksView);
</script>

<template>
  <div class="shell">
    <AppSidebar />

    <main class="main" :class="{ wide: view === 'terminals' }">
      <div class="msg" :class="{ err }">{{ msg }}</div>
      <RunProgress />

      <KeepAlive>
        <component :is="page" />
      </KeepAlive>
    </main>

    <ProjectPicker v-if="projPickOpen" />
    <ProjectDialog v-if="projOpen" />
    <RepoDialog v-if="repoOpen" />
    <SplitDialog v-if="splitItem" />
    <TemplateDialog v-if="tplOpen" />
    <MarkDialog v-if="markFor" />
    <ResultSheet v-if="sheet" />
    <ConfirmDialog v-if="confirmReq" />
  </div>
</template>
