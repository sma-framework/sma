/**
 * Placeholder — what a screen shows before it is built.
 *
 * Every screen has its place in the window from the first day, so the sidebar tells the
 * truth about what the window will contain and nothing has to be rearranged later. A
 * screen that is not ready says so plainly and promises nothing.
 */
export function Placeholder({ title }: { title: string }) {
  return (
    <section className="flex flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] items-center gap-3.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-tx">{title}</h1>
      </header>
      <div className="flex flex-1 items-center justify-center p-7">
        <p className="text-[13px] text-tx2">Экран строится.</p>
      </div>
    </section>
  )
}
