/** @jsxImportSource https://esm.sh/react@18.2.0 */
import { useState } from "https://esm.sh/react@18.2.0";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div class="flex items-center gap-3">
      <span class="text-lg">Clicked</span>
      <button
        onClick={() => setCount((c) => c + 1)}
        class="bg-blue-500 hover:bg-blue-600 text-white font-medium px-4 py-2 rounded-lg transition-colors cursor-pointer"
      >
        {count}
      </button>
      <span class="text-lg">times</span>
    </div>
  );
}
