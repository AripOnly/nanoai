// src/components/TextArea.jsx
export default function TextArea({ value = "", onChange }) {
  const rows = Math.max(1, value.split("\n").length);

  return (
    <textarea
      name="prompt"
      id="prompt"
      value={value}
      rows={rows}
      autoFocus
      placeholder="Tanyakan apa saja..."
      className="py-2 w-full resize-none outline-none max-h-64 scrollbar-none"
      onChange={onChange}
      onKeyDown={(event) => {
        event.stopPropagation();

        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }}
    />
  );
}
