<script lang="ts">
  import { ToastHost } from '@nolzu/ui';
  import { dismissed } from './board-page.ts';
  import { toastStack } from './toast-stack.svelte.ts';
</script>

<!-- The one toast host. The root layout mounts it once, beside every page. -->
<ToastHost toasts={toastStack.state.toasts} ondismiss={(key) => (toastStack.state = dismissed(toastStack.state, key))} />
