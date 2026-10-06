// src/components/UserInput.jsx
import { useState } from "react";
import TextArea from "./TextArea";
import { Plus, ArrowUp } from "lucide-react";

export default function UserInput({ sendMessage, newSession }) {
  const [value, setValue] = useState("");

  const handleSubmit = (event) => {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const prompt = formData.get("prompt");

    setValue("");
    sendMessage({ prompt });
  };

  return (
    <div className={`flex justify-center relative`}>
      <div
        className={`w-full max-w-3xl border border-gray-500 ${!newSession ? "absolute bottom-2" : ""} rounded-lg bg-white p-2 box-border shadow-[0_0_25px_20px_rgba(255,255,255,1)]`}
      >
        <form method="POST" onSubmit={handleSubmit}>
          <TextArea
            value={value}
            onChange={(event) => setValue(event.target.value)}
          ></TextArea>

          {/* uploade */}
          <div className="flex flex-row flex-nowrap items-center">
            <div className="p-2">
              <label
                htmlFor="uploade"
                className="inline-block rounded-[50%] p-1.5 cursor-pointer hover:bg-gray-200 active:scale-95"
              >
                <Plus size={25} />
              </label>

              <input type="file" name="uploade" id="uploade" hidden />
            </div>

            <div className="ml-auto p-2 bg-blue-500 flex justify-center items-center rounded-[50%] text-white hover:bg-blue-600 active:scale-95">
              <button name="submit" type="submit">
                <ArrowUp size={25}></ArrowUp>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
