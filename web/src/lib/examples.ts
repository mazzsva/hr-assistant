export interface Example {
  label: string;
  question: string;
}

export const examples: Example[] = [
  { label: "Policy lookup", question: "How many leave days can I carry over?" },
  {
    label: "Competing rules",
    question: "Do I get a premium for a night shift on a Sunday?",
  },
  {
    label: "Multi-part policy",
    question:
      "What is the referral bonus for an engineering role, and when is it paid?",
  },
  {
    label: "Structured query",
    question: "How many people work in Engineering?",
  },
  {
    label: "Not in the handbook",
    question: "What is the company policy on sabbaticals of over a year?",
  },
  {
    label: "Personal record",
    question: "What is my performance rating for this year?",
  },
];
