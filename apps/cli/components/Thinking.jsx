// Thinking.jsx

import React from "react";
import { Text } from "ink";
import Spinner from "./Spinner.jsx";

const Thinking = () => {
  return (
    <Text>
      <Text color="green">
        <Spinner type="dots" />
      </Text>
      {" Thinking..."}
    </Text>
  );
};

export default Thinking;
